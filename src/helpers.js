const Apify = require('apify');
const tunnel = require('tunnel');
const { CookieJar } = require('tough-cookie');
const got = require('got');
const { URLSearchParams } = require('url');
const Puppeteer = require('puppeteer'); // eslint-disable-line no-unused-vars
const errors = require('./errors');
const { expandOwnerDetails } = require('./user-details');
const { PAGE_TYPES, GRAPHQL_ENDPOINT, LOG_TYPES, PAGE_TYPE_URL_REGEXES, HEADERS } = require('./consts');

const { sleep, requestAsBrowser } = Apify.utils;

const getPageTypeFromUrl = (url) => {
    for (const [pageType, regex] of Object.entries(PAGE_TYPE_URL_REGEXES)) {
        if (url.match(regex)) {
            return PAGE_TYPES[pageType];
        }
    }
};

/**
 * Takes object from _sharedData.entry_data and parses it into simpler object
 * @param {Object} entryData
 */
const getItemSpec = (entryData) => {
    if (entryData.LocationsPage) {
        const itemData = entryData.LocationsPage[0].graphql.location;
        return {
            pageType: PAGE_TYPES.PLACE,
            id: itemData.slug,
            locationId: itemData.id,
            locationSlug: itemData.slug,
            locationName: itemData.name,
        };
    }

    if (entryData.TagPage) {
        const itemData = entryData.TagPage[0].graphql.hashtag;
        return {
            pageType: PAGE_TYPES.HASHTAG,
            id: itemData.name,
            tagId: itemData.id,
            tagName: itemData.name,
        };
    }

    if (entryData.ProfilePage) {
        const itemData = entryData.ProfilePage[0].graphql.user;
        return {
            pageType: PAGE_TYPES.PROFILE,
            id: itemData.username,
            userId: itemData.id,
            userUsername: itemData.username,
            userFullName: itemData.full_name,
        };
    }

    if (entryData.PostPage) {
        const itemData = entryData.PostPage[0].graphql.shortcode_media;
        return {
            pageType: PAGE_TYPES.POST,
            id: itemData.shortcode,
            postCommentsDisabled: itemData.comments_disabled,
            postIsVideo: itemData.is_video,
            postVideoViewCount: itemData.video_view_count || 0,
            postVideoDurationSecs: itemData.video_duration || 0,
        };
    }

    if (entryData.StoriesPage) {
        return {
            pageType: PAGE_TYPES.STORY,
        };
    }

    Apify.utils.log.info('unsupported page', entryData);

    throw errors.unsupportedPage();
};

/**
 * Takes page data containing type of page and outputs short label for log line
 * @param {Object} pageData Object representing currently loaded IG page
 */
const getLogLabel = (pageData) => {
    switch (pageData.pageType) {
        case PAGE_TYPES.PLACE:
            return `Place "${pageData.locationName}"`;
        case PAGE_TYPES.PROFILE:
            return `User "${pageData.userUsername}"`;
        case PAGE_TYPES.HASHTAG:
            return `Tag "${pageData.tagName}"`;
        case PAGE_TYPES.POST:
            return `Post "${pageData.id}"`;
        case PAGE_TYPES.STORY:
            return 'Story';
        default:
            throw new Error('Not supported');
    }
};

/**
 * Takes page type and outputs variable that must be present in graphql query
 * @param {String} pageType
 */
const getCheckedVariable = (pageType) => {
    switch (pageType) {
        case PAGE_TYPES.PLACE:
            return '%22id%22';
        case PAGE_TYPES.PROFILE:
            return '%22id%22';
        case PAGE_TYPES.HASHTAG:
            return '%22tag_name%22';
        case PAGE_TYPES.POST:
            return '%22shortcode%22';
        default:
            throw new Error('Not supported');
    }
};

/**
 * Based on parsed data from current page saves a message into log with prefix identifying current page
 * @param {Object} pageData Parsed page data
 * @param {String} message Message to be outputed
 */
function log(itemSpec, message, type = 'info') {
    const label = getLogLabel(itemSpec);
    Apify.utils.log[type](`${label}: ${message}`);
}

const grapqlEndpoint = 'https://www.instagram.com/graphql/query/';

/**
 * @param {Puppeteer.Page} page
 * @param {{ proxy: import("apify").ProxyConfigurationOptions | undefined; } | undefined} [input]
 */
async function getGotParams(page, input) {
    // It is necessary to create it here as well because passing it over is to ridiculous
    const proxyConfiguration = await Apify.createProxyConfiguration(input.proxy);

    if (!proxyConfiguration) {
        return;
    }
    const proxyUrl = proxyConfiguration.newUrl();

    const userAgent = await page.browser().userAgent();

    const proxyUrlParts = proxyUrl.match(/http:\/\/(.*)@(.*)\/?/);
    if (!proxyUrlParts) return;

    const proxyHost = proxyUrlParts[2].split(':');
    const proxyConfig = {
        hostname: proxyHost[0],
        proxyAuth: proxyUrlParts[1],
    };
    if (proxyHost[1]) proxyConfig.port = proxyHost[1];

    const agent = tunnel.httpsOverHttp({
        proxy: proxyConfig,
    });

    const cookies = await page.cookies();
    const cookieJar = new CookieJar();
    cookies.forEach((cookie) => {
        if (cookie.name === 'urlgen') return;
        cookieJar.setCookieSync(`${cookie.name}=${cookie.value}`, 'https://www.instagram.com/', {
            http: true,
            secure: true,
        });
    });

    return {
        agent,
        cookieJar,
        headers: {
            'user-agent': userAgent,
        },
        json: true,
    };
}

async function query(gotParams, searchParams, nodeTransformationFunc, itemSpec, logPrefix) {
    let retries = 0;
    while (retries < 10) {
        try {
            const { body } = await got(`${grapqlEndpoint}?${searchParams.toString()}`, gotParams);
            if (!body.data) throw new Error(`${logPrefix} - GraphQL query does not contain data`);
            return nodeTransformationFunc(body.data);
        } catch (error) {
            if (error.message.includes(429)) {
                log(itemSpec, `${logPrefix} - Encountered rate limit error, waiting ${(retries + 1) * 10} seconds.`, LOG_TYPES.WARNING);
                await sleep((retries + 1) * 10000);
            } else {
                Apify.utils.log.error(error);
            }
            retries++;
        }
    }
    log(itemSpec, `${logPrefix} - Could not load more items`);
    return { nextPageCursor: null, data: [] };
}

async function finiteQuery(queryId, variables, nodeTransformationFunc, limit, page, input, itemSpec, logPrefix) {
    const gotParams = await getGotParams(page, input);

    log(itemSpec, `${logPrefix} - Loading up to ${limit} items`);
    let hasNextPage = true;
    let endCursor = null;
    const results = [];
    while (hasNextPage && results.length < limit) {
        const queryParams = {
            query_hash: queryId,
            variables: {
                ...variables,
                first: 50,
            },
        };
        if (endCursor) queryParams.variables.after = endCursor;
        const searchParams = new URLSearchParams([['query_hash', queryParams.query_hash], ['variables', JSON.stringify(queryParams.variables)]]);
        const { nextPageCursor, data } = await query(gotParams, searchParams, nodeTransformationFunc, itemSpec, logPrefix);

        data.forEach((result) => results.push(result));

        if (nextPageCursor && results.length < limit) {
            endCursor = nextPageCursor;
            log(itemSpec, `${logPrefix} - So far loaded ${results.length} items`);
        } else {
            hasNextPage = false;
        }
    }
    log(itemSpec, `${logPrefix} - Finished loading ${results.length} items`);
    return results.slice(0, limit);
}

async function singleQuery(queryId, variables, nodeTransformationFunc, page, itemSpec, logPrefix) {
    const gotParams = await getGotParams(page, itemSpec.input);
    const searchParams = new URLSearchParams([['query_hash', queryId], ['variables', JSON.stringify(variables)]]);
    return query(gotParams, searchParams, nodeTransformationFunc, itemSpec, logPrefix);
}

function parseExtendOutputFunction(extendOutputFunction) {
    let parsedExtendOutputFunction;
    if (typeof extendOutputFunction === 'string' && extendOutputFunction.trim() !== '') {
        try {
            parsedExtendOutputFunction = eval(extendOutputFunction);
        } catch (e) {
            throw new Error(`'extendOutputFunction' is not valid Javascript! Error: ${e}`);
        }
        if (typeof parsedExtendOutputFunction !== 'function') {
            throw new Error('extendOutputFunction is not a function! Please fix it or use just default ouput!');
        }
    }
}

/**
 * @param {string} caption
 */
function parseCaption(caption) {
    if (!caption) {
        return { hashtags: [], mentions: [] };
    }
    // last part means non-spaced tags, like #some#tag#here
    // works with unicode characters. de-duplicates tags and mentions
    const HASHTAG_REGEX = /#([\S]+?)(?=\s|$|[#@])/gums;
    const MENTION_REGEX = /@([\S]+?)(?=\s|$|[#@])/gums;
    const clean = (regex) => [...new Set(([...caption.matchAll(regex)] || []).filter((s) => s[1]).map((s) => s[1].trim()))];
    const hashtags = clean(HASHTAG_REGEX);
    const mentions = clean(MENTION_REGEX);
    return { hashtags, mentions };
}

function hasReachedLastPostDate(scrapePostsUntilDate, lastPostDate, itemSpec) {
    const lastPostDateAsDate = new Date(lastPostDate);
    if (scrapePostsUntilDate) {
        // We want to continue scraping (return true) if the scrapePostsUntilDate is older (smaller) than the date of the last post
        // Don't forget we scrape from the most recent ones to the past
        scrapePostsUntilDateAsDate = new Date(scrapePostsUntilDate);
        const willContinue = scrapePostsUntilDateAsDate < lastPostDateAsDate;
        if (!willContinue) {
            log(itemSpec, `Reached post with older date than our limit: ${lastPostDateAsDate}. Finishing scrolling...`, LOG_TYPES.WARNING);
            return true;
        }
    }
    return false;
}

// Ttems can be posts or commets from scrolling
async function filterPushedItemsAndUpdateState({ items, itemSpec, parsingFn, scrollingState, type, page }) {
    if (!scrollingState[itemSpec.id]) {
        scrollingState[itemSpec.id] = {
            allDuplicates: false,
            ids: {},
        };
    }
    const { limit, scrapePostsUntilDate } = itemSpec;
    const currentScrollingPosition = Object.keys(scrollingState[itemSpec.id].ids).length;
    const parsedItems = parsingFn(items, itemSpec, currentScrollingPosition);
    let itemsToPush = [];
    for (const item of parsedItems) {
        if (Object.keys(scrollingState[itemSpec.id].ids).length >= limit) {
            log(itemSpec, `Reached user provided limit of ${limit} results, stopping...`);
            break;
        }
        if (scrapePostsUntilDate && hasReachedLastPostDate(scrapePostsUntilDate, item.timestamp, itemSpec)) {
            scrollingState[itemSpec.id].reachedLastPostDate = true;
            break;
        }
        if (!scrollingState[itemSpec.id].ids[item.id]) {
            itemsToPush.push(item);
            scrollingState[itemSpec.id].ids[item.id] = true;
        } else {
            // Apify.utils.log.debug(`Item: ${item.id} was already pushed, skipping...`);
        }
    }
    // We have to tell the state if we are going though duplicates so it knows it should still continue scrolling
    if (itemsToPush.length === 0) {
        scrollingState[itemSpec.id].allDuplicates = true;
    } else {
        scrollingState[itemSpec.id].allDuplicates = false;
    }
    if (type === 'posts') {
        if (itemSpec.input.expandOwners && itemSpec.pageType !== PAGE_TYPES.PROFILE) {
            itemsToPush = await expandOwnerDetails(itemsToPush, page, itemSpec);
        }

        // I think this feature was added by Tin and it could possibly increase the runtime by A LOT
        // It should be opt-in. Also needs to refactored!
        /*
        for (const post of output) {
            if (itemSpec.pageType !== PAGE_TYPES.PROFILE && (post.locationName === null || post.ownerUsername === null)) {
                // Try to scrape at post detail
                await requestQueue.addRequest({ url: post.url, userData: { label: 'postDetail' } });
            } else {
                await Apify.pushData(post);
            }
        }
        */
    }
    return itemsToPush;
}

const shouldContinueScrolling = ({ scrollingState, itemSpec, oldItemCount, type }) => {
    if (type === 'posts') {
        if (scrollingState[itemSpec.id].reachedLastPostDate) {
            return false;
        }
    }

    const itemsScrapedCount = Object.keys(scrollingState[itemSpec.id].ids).length;
    const reachedLimit = itemsScrapedCount >= itemSpec.limit;
    if (reachedLimit) {
        console.warn(`Reached max results (posts or commets) limit: ${itemSpec.limit}. Finishing scrolling...`);
    }
    const shouldGoNextGeneric = !reachedLimit && (itemsScrapedCount !== oldItemCount || scrollingState[itemSpec.id].allDuplicates);
    return shouldGoNextGeneric;
};

/**
 * @param {{
 *   itemSpec: any,
 *   page: Puppeteer.Page,
 *   retry?: number,
 *   type: 'posts' | 'comments'
 * }} params
 */
const loadMore = async ({ itemSpec, page, retry = 0, type }) => {
    // console.log('Starting load more fn')
    await page.keyboard.press('PageUp');
    const checkedVariable = getCheckedVariable(itemSpec.pageType);
    const responsePromise = page.waitForResponse(
        (response) => {
            const responseUrl = response.url();
            return responseUrl.startsWith(GRAPHQL_ENDPOINT)
                && responseUrl.includes(checkedVariable)
                && responseUrl.includes('%22first%22');
        },
        { timeout: 30000 },
    ).catch(() => null);

    // comments scroll up with button
    let clicked = [];
    for (let i = 0; i < 10; i++) {
        let elements;
        if (type === 'posts') {
            elements = await page.$$('button.tCibT');
        } else if (type === 'comments') {
            elements = await page.$$('[aria-label="Load more comments"]');
        } else {
            throw new Error('Type has to be "posts" or "comments"!');
        }

        if (elements.length === 0) {
            continue; // eslint-disable-line no-continue
        }
        const [button] = elements;

        try {
            clicked = await Promise.all([
                button.click(),
                page.waitForRequest(
                    (request) => {
                        const requestUrl = request.url();
                        return requestUrl.startsWith(GRAPHQL_ENDPOINT)
                            && requestUrl.includes(checkedVariable)
                            && requestUrl.includes('%22first%22');
                    },
                    {
                        timeout: 1000,
                    },
                ).catch(() => null),
            ]);

            if ((await page.$$('[role="dialog"]')).length) {
                // login popup appeared, abort
                throw new Error('Login popup appeared, retrying...');
            }

            if (clicked[1]) break;
        } catch (e) {
            Apify.utils.log.debug('loadMore error', { error: e.message, stack: e.stack });

            if (e.message.includes('Login')) {
                throw e;
            }

            // "Node is either not visible or not an HTMLElement" from button.click(), would propagate and
            // break the whole recursion needlessly
            continue; // eslint-disable-line no-continue
        }
    }

    // posts scroll down
    let scrolled = [];
    if (type === 'posts') {
        for (let i = 0; i < 10; i++) {
            scrolled = await Promise.all([
                // eslint-disable-next-line no-restricted-globals
                page.evaluate(() => window.scrollBy(0, 9999999)),
                page.waitForRequest(
                    (request) => {
                        const requestUrl = request.url();
                        return requestUrl.startsWith(GRAPHQL_ENDPOINT)
                            && requestUrl.includes(checkedVariable)
                            && requestUrl.includes('%22first%22');
                    },
                    {
                        timeout: 1000,
                    },
                ).catch(() => null),
            ]);
            if (scrolled[1]) break;
        }
    }

    let data = null;

    // the [+] button is removed from page when no more comments are loading
    if (type === 'comments' && !clicked.length && retry > 0) {
        return { data };
    }

    const response = await responsePromise;
    if (!response) {
        log(itemSpec, 'Didn\'t receive a valid response in the current scroll, scrolling again...', LOG_TYPES.WARNING);
    } else {
        // if (scrolled[1] || clicked[1]) {
        try {
            // const response = await responsePromise;
            // if (!response) {
            //    log(itemSpec, `Didn't receive a valid response in the current scroll, scrolling more...`, LOG_TYPES.WARNING);
            // } else {
            const status = response.status();

            if (status === 429) {
                return { rateLimited: true };
            }

            if (status !== 200) {
                log(itemSpec, `Got error status while scrolling: ${status}`, LOG_TYPES.ERROR);
            } else {
                let json;
                try {
                    json = await response.json();
                } catch (e) {
                    log(itemSpec, 'Cannot parse response body', LOG_TYPES.EXCEPTION);
                    console.dir(response);
                }

                // eslint-disable-next-line prefer-destructuring
                if (json) data = json.data;
            }
            // }
        } catch (error) {
            // Apify.utils.log.error(error);
            log(itemSpec, 'Non fatal error occured while scrolling:', LOG_TYPES.WARNING);
            console.dir(error);
        }
    }

    if (type === 'comments') {
        // delete nodes to make DOM less bloated
        await page.evaluate(() => {
            document.querySelectorAll('.EtaWk > ul > ul').forEach((s) => s.remove());
        });
    }

    if (!data && retry < 10 && (scrolled[1] || retry < 5)) {
        // We scroll the other direction than usual
        if (type === 'posts') {
            await page.evaluate(() => window.scrollBy(0, -1000));
        }
        const retryDelay = retry ? (retry + 1) * retry * 1000 : (retry + 1) * 1000;
        log(itemSpec, `Retry scroll after ${retryDelay / 1000} seconds`);
        await sleep(retryDelay);
        return loadMore({ itemSpec, page, retry: retry + 1, type });
    }

    await sleep(100);
    return { data };
};

const finiteScroll = async (context) => {
    const {
        itemSpec,
        page,
        scrollingState,
        getItemsFromGraphQLFn,
        type,
        puppeteerPool,
    } = context;
    // console.log('starting finite scroll');
    const oldItemCount = Object.keys(scrollingState[itemSpec.id].ids).length;
    const { data, rateLimited } = await loadMore({ itemSpec, page, type });

    if (rateLimited) {
        log(itemSpec, 'Scrolling got blocked by Instagram, finishing! Please increase the "scrollWaitSecs" input and run again.', LOG_TYPES.EXCEPTION);
        return;
    }

    // console.log('Getting data from graphQl')
    if (data) {
        const { hasNextPage } = getItemsFromGraphQLFn({ data, pageType: itemSpec.pageType });
        if (!hasNextPage) {
            // log(itemSpec, 'Cannot find new page of scrolling, storing last page dump to KV store', LOG_TYPES.WARNING);
            // await Apify.setValue(`LAST-PAGE-DUMP-${itemSpec.id}`, data);
            // We have to do these retires because the browser sometimes hang on, should be fixable with something else though
            await puppeteerPool.retire(page.browser());

            // this is actually expected, the total count usually isn't the amount of actual loaded comments/posts
            return;
        }
    }
    // console.log('Got data from graphQl')

    // There is a rate limit in scrolling, we don;t know exactly how much
    // If you reach it, it will block you completely so it is necessary to wait more in scrolls
    // Seems the biggest block chance is when you are over 2000 items
    const { scrollWaitSecs } = itemSpec;
    if (oldItemCount > 1000) {
        const modulo = oldItemCount % 100;
        if (modulo >= 0 && modulo < 12) { // Every 100 posts: Wait random for user passed time with some randomization
            const waitSecs = Math.round(scrollWaitSecs * (Math.random() + 1));
            log(itemSpec, `Sleeping for ${waitSecs} seconds to prevent getting rate limit error..`);
            await sleep(waitSecs * 1000);
        }
    }

    // Small ranom wait (200-600ms) in between each scroll
    const waitMs = Math.round(200 * (Math.random() * 2 + 1));
    // console.log(`Waiting for ${waitMs} ms`);
    await sleep(waitMs);

    const doContinue = shouldContinueScrolling({ scrollingState, itemSpec, oldItemCount, type });

    if (doContinue) {
        await finiteScroll(context);
    }
};

/**
 * Load data from XHR request using current page cookies and headers
 * @param {Request} request - request as referer
 * @param {Puppeteer.Page} page - current page object
 * @param {String} url - xhr url
 * @param {String|null} proxyUrl - url of current proxy
 * @param {String} csrf_token - used in headers
 * @returns {Promise<Response>}
 */
const loadXHR = async ({ request, page, url, proxyUrl, csrf_token }) => {
    const cookies = await page.cookies();
    let serializedCookies = '';
    for (const cookie of cookies) {
        serializedCookies += `${cookie.name}=${cookie.value}; `;
    }
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const headers = {
        referer: request.url,
        'x-csrftoken': csrf_token,
        cookie: serializedCookies,
        'user-agent': userAgent,
        ...HEADERS,
    };

    const res = await requestAsBrowser({
        url,
        timeoutSecs: 30,
        proxyUrl,
        headers,
    });
    return res;
};

/**
 * @param {Puppeteer.Page} page
 */
const acceptCookiesDialog = async (page) => {
    const acceptBtn = '[role="dialog"] button:first-of-type';

    try {
        await page.waitForSelector(acceptBtn, { timeout: 5000 });
    } catch (e) {
        return false;
    }

    await Promise.all([
        page.waitForResponse(() => true),
        page.click(acceptBtn),
    ]);

    return true;
};

module.exports = {
    getPageTypeFromUrl,
    getItemSpec,
    getCheckedVariable,
    log,
    finiteQuery,
    acceptCookiesDialog,
    singleQuery,
    parseExtendOutputFunction,
    parseCaption,
    filterPushedItemsAndUpdateState,
    finiteScroll,
    shouldContinueScrolling,
    loadXHR,
};
