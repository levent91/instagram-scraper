const Apify = require('apify');
const vm = require('vm');
const moment = require('moment');
const Puppeteer = require('puppeteer'); // eslint-disable-line no-unused-vars
const { get } = require('lodash');
const { gotScraping } = require('got-scraping');
const errors = require('./errors');
const { expandOwnerDetails } = require('./user-details');
const { PAGE_TYPES, GRAPHQL_ENDPOINT, LOG_TYPES, PAGE_TYPE_URL_REGEXES } = require('./consts');

const { sleep } = Apify.utils;

/**
 * @param {{
 *   hash: string,
 *   variables: Record<string, any>
 * }} params
 */
const queryHash = ({
    hash,
    variables,
}) => {
    return new URLSearchParams([
        ['query_hash', hash],
        ['variables', JSON.stringify(variables)],
    ]);
};

/**
 * @param {{
 *   proxyConfiguration?: Apify.ProxyConfiguration,
 * }} params
 */
const createGotRequester = ({ proxyConfiguration }) => {
    /**
     * @param {{
     *   url: string,
     *   session?: Apify.Session,
     *   headers?: Record<string, any>,
     *   method?: 'GET' | 'POST',
     *   proxyUrl?: string
     * }} params
     */
    return async ({
        url,
        session,
        proxyUrl = proxyConfiguration?.newUrl(session?.id ?? `sess${Math.round(Math.random() * 10000)}`),
        headers = {},
        method = 'GET',
    }) => {
        return gotScraping({
            url,
            method,
            proxyUrl,
            headers: {
                ...headers,
            },
            responseType: 'json',
            https: {
                rejectUnauthorized: false,
            },
        });
    };
};

/**
 * @param {Array<{ obj: any, paths: string[] }>} objs
 * @param {any} [fallback]
 */
const coalesce = (objs, fallback = {}) => {
    return objs.reduce((out, { obj, paths }) => {
        return out || paths.reduce((found, path) => (typeof found !== 'undefined' ? found : get(obj, path)), undefined);
    }, undefined) || fallback;
};

const getPageTypeFromUrl = (url) => {
    for (const [pageType, regex] of Object.entries(PAGE_TYPE_URL_REGEXES)) {
        if (url.match(regex)) {
            return PAGE_TYPES[pageType];
        }
    }
};

/**
 * Takes object from _sharedData.entry_data and parses it into simpler object
 * @param {Record<string, any>} entryData
 * @param {Record<string, any>} additionalData
 */
const getItemSpec = (entryData, additionalData) => {
    if (entryData.LocationsPage) {
        const itemData = coalesce([
            { obj: entryData,
                paths: [
                    'LocationsPage[0].graphql.location',
                    'LocationsPage[0].native_location_data.location_info',
                ] },
            { obj: additionalData, paths: ['graphql.location'] },
        ]);
        return {
            pageType: PAGE_TYPES.PLACE,
            id: itemData.slug ?? itemData.location_id,
            locationId: itemData.id ?? itemData.location_id,
            locationSlug: itemData.slug ?? itemData.location_id,
            locationName: itemData.name,
        };
    }

    if (entryData.TagPage) {
        const itemData = coalesce([
            { obj: entryData,
                paths: [
                    'TagPage[0].graphql.hashtag',
                    'TagPage[0].data',
                ],
            },
            { obj: additionalData, paths: ['graphql.hashtag'] },
        ]);
        return {
            pageType: PAGE_TYPES.HASHTAG,
            id: itemData.name,
            tagId: itemData.id,
            tagName: itemData.name,
        };
    }

    if (entryData.ProfilePage) {
        const itemData = coalesce([
            { obj: entryData, paths: ['ProfilePage[0].graphql.user'] },
            { obj: additionalData, paths: ['graphql.user'] },
        ]);
        return {
            pageType: PAGE_TYPES.PROFILE,
            id: itemData.username,
            userId: itemData.id,
            userUsername: itemData.username,
            userFullName: itemData.full_name,
        };
    }

    if (entryData.PostPage) {
        const itemData = coalesce([
            { obj: entryData, paths: ['PostPage[0].graphql.shortcode_media'] },
            { obj: additionalData, paths: ['graphql.shortcode_media'] },
        ]);

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

    if (entryData.Challenge) {
        return {
            pageType: PAGE_TYPES.CHALLENGE,
        };
    }

    Apify.utils.log.info('unsupported page', entryData);

    throw errors.unsupportedPage();
};

/**
 * Takes page data containing type of page and outputs short label for log line
 * @param {Record<string, any>} pageData Object representing currently loaded IG page
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
 * @param {any} itemSpec
 * @param {string} message
 * @param {string} type
 */
function log(itemSpec, message, type = LOG_TYPES.INFO) {
    const label = getLogLabel(itemSpec);
    Apify.utils.log[type](`${label}: ${message}`);
}

/**
 * @param {string} url
 * @param {Puppeteer.Page} page
 * @param {(data: any) => any} nodeTransformationFunc
 * @param {any} itemSpec
 * @param {string} logPrefix
 * @param {boolean} [isData]
 */
async function query(
    url,
    page,
    nodeTransformationFunc,
    itemSpec,
    logPrefix,
    isData = true,
) {
    let retries = 0;
    while (retries < 10) {
        try {
            const body = await page.evaluate(async ({ url, APP_ID, ASBD }) => {
                const res = await fetch(url, {
                    headers: {
                        'user-agent': window.navigator.userAgent,
                        accept: '*/*',
                        'accept-language': `${window.navigator.language};q=0.9`,
                        'x-asbd-id': ASBD,
                        'x-ig-app-id': APP_ID,
                        'x-ig-www-claim': sessionStorage.getItem('www-claim-v2') || 0,
                        ...(url.includes('/v1') ? {} : {
                            'x-csrftoken': window._sharedData?.config?.csrf_token
                                ?? window.__initialData?.data?.config.csrf_token,
                            'x-requested-with': 'XMLHttpRequest',
                        }),
                    },
                    referrer: 'https://www.instagram.com/',
                    credentials: 'include',
                    mode: 'cors',
                });

                if (res.status !== 200) {
                    throw new Error(`Status code ${res.status}`);
                }

                try {
                    return await res.json();
                } catch (e) {
                    throw new Error('Invalid response returned');
                }
            }, {
                url,
                APP_ID: process.env.APP_ID,
                ASBD: process.env.ASBD,
            });

            if (isData && !body?.data) throw new Error(`${logPrefix} - GraphQL query does not contain data`);

            return nodeTransformationFunc(isData ? body.data : body);
        } catch (error) {
            Apify.utils.log.debug('query', { url, message: error.message });

            if (error.message.includes(429)) {
                log(itemSpec, `${logPrefix} - Encountered rate limit error, waiting ${(retries + 1) * 10} seconds.`, LOG_TYPES.WARNING);
                await sleep((retries++ + 1) * 10000);
            } else {
                throw error;
            }
        }
    }

    log(itemSpec, `${logPrefix} - Could not load more items`);
    return { nextPageCursor: null, data: [] };
}

/**
 *
 * @param {string} hash
 * @param {Record<string, any>} variables
 * @param {(data: any) => any} nodeTransformationFunc
 * @param {number} limit
 * @param {Puppeteer.Page} page
 * @param {any} itemSpec
 * @param {string} logPrefix
 */
async function finiteQuery(hash, variables, nodeTransformationFunc, limit, page, itemSpec, logPrefix) {
    log(itemSpec, `${logPrefix} - Loading up to ${limit} items`);
    let hasNextPage = true;
    let endCursor = null;
    /** @type {any[]} */
    const results = [];
    while (hasNextPage && results.length < limit) {
        const queryParams = {
            hash,
            variables: {
                ...variables,
                first: 50,
            },
        };
        if (endCursor) queryParams.variables.after = endCursor;
        const { nextPageCursor, data } = await query(
            `${GRAPHQL_ENDPOINT}?${queryHash(queryParams)}`,
            page,
            nodeTransformationFunc,
            itemSpec,
            logPrefix,
        );

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

/**
 * @param {string} hash
 * @param {Record<string,any>} variables
 * @param {(data: any) => any} nodeTransformationFunc
 * @param {Puppeteer.Page} page
 * @param {any} itemSpec
 * @param {string} logPrefix
 */
async function singleQuery(hash, variables, nodeTransformationFunc, page, itemSpec, logPrefix) {
    return query(
        `${GRAPHQL_ENDPOINT}?${queryHash({ hash, variables })}`,
        page,
        nodeTransformationFunc,
        itemSpec,
        logPrefix,
    );
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

/**
 * @param {{
 *   items: any[],
 *   itemSpec: any,
 *   parsingFn: (items: any[], itemSpec: any, position: number) => any[],
 *   scrollingState: Record<string, any>,
 *   type: 'posts' | 'comments',
 *   page: Puppeteer.Page,
 * }} param0
 */
async function filterPushedItemsAndUpdateState({ items, itemSpec, parsingFn, scrollingState, type, page }) {
    if (!scrollingState[itemSpec.id]) {
        scrollingState[itemSpec.id] = {
            allDuplicates: false,
            ids: {},
        };
    }
    const { limit, minMaxDate } = itemSpec;
    const currentScrollingPosition = Object.keys(scrollingState[itemSpec.id].ids).length;
    const parsedItems = parsingFn(items, itemSpec, currentScrollingPosition);
    let itemsToPush = [];

    const isAllOutOfTimeRange = parsedItems.every(({ timestamp }) => {
        return (minMaxDate.minDate?.isAfter(timestamp) === true) || (minMaxDate.maxDate?.isBefore(timestamp) === true);
    });

    for (const item of parsedItems) {
        if (Object.keys(scrollingState[itemSpec.id].ids).length >= limit) {
            log(itemSpec, `Reached user provided limit of ${limit} results, stopping...`);
            break;
        }
        if (!scrollingState[itemSpec.id].ids[item.id]) {
            itemsToPush.push(item);
            scrollingState[itemSpec.id].ids[item.id] = true;
        } else {
            // Apify.utils.log.debug(`Item: ${item.id} was already pushed, skipping...`);
        }
    }

    if (isAllOutOfTimeRange) {
        log(itemSpec, 'Max date has been reached');
        scrollingState[itemSpec.id].reachedLastPostDate = true;
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
    if (type === 'posts' || type === 'comments') {
        if (scrollingState[itemSpec.id].reachedLastPostDate) {
            return false;
        }
    }

    const itemsScrapedCount = Object.keys(scrollingState[itemSpec.id].ids).length;
    const reachedLimit = itemsScrapedCount >= itemSpec.limit;
    if (reachedLimit) {
        console.warn(`Reached max results (posts or comments) limit: ${itemSpec.limit}. Finishing scrolling...`);
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
    if (page.isClosed()) {
        return {
            data: null,
        };
    }

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

            await acceptCookiesDialog(page);

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

    /**
     * posts scroll down
     * @type {Array<null|void|Puppeteer.HTTPRequest>}
     */
    let scrolled = [];
    if (type === 'posts') {
        for (let i = 0; i < 10; i++) {
            scrolled = await Promise.all([
                page.evaluate(() => window.scrollBy(0, document.body.scrollHeight)),
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
        throw new Error('Didn\'t receive a valid response in the current scroll, scrolling again...');
    } else {
        // if (scrolled[1] || clicked[1]) {
        try {
            // const response = await responsePromise;
            // if (!response) {
            //    log(itemSpec, `Didn't receive a valid response in the current scroll, scrolling more...`, LOG_TYPES.WARNING);
            // } else {
            const status = response.status();

            if (status === 429) {
                const { scrollWaitMillis } = itemSpec;
                await sleep(scrollWaitMillis);

                return { rateLimited: true };
            }

            if (status !== 200) {
                // usually 302 redirecting to login, throwing string to remove the long stack trace
                throw new Error(`Got error status while scrolling: ${status}. Retrying...`);
            }

            let json;
            try {
                json = await response.json();
            } catch (e) {
                log(itemSpec, 'Cannot parse response body', LOG_TYPES.EXCEPTION);
                console.dir(response);
            }

            // eslint-disable-next-line prefer-destructuring
            if (json) data = json.data;
        } catch (error) {
            // Apify.utils.log.error(error);
            const errorMessage = error.message || error;
            if (errorMessage.includes('Got error')) {
                throw error;
            } else {
                log(itemSpec, 'Non fatal error occured while scrolling:', LOG_TYPES.WARNING);
            }
        }
    }

    if (type === 'comments') {
        // delete nodes to make DOM less bloated
        await page.evaluate(() => {
            document.querySelectorAll('.EtaWk > ul > ul').forEach((s) => s.remove());
        });
    }

    const retryDelay = (retry || 1) * 3500;

    if (!data && retry < 4 && (scrolled[1] || retry < 5)) {
        // We scroll the other direction than usual
        if (type === 'posts') {
            await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight * 0.70 }));
        }
        log(itemSpec, `Retry scroll after ${retryDelay / 3600} seconds`);
        await sleep(retryDelay);
        return loadMore({ itemSpec, page, retry: retry + 1, type });
    }

    await sleep(retryDelay / 2);

    return { data };
};

/**
 * @param {{
 *   itemSpec: any,
 *   page: Puppeteer.Page,
 *   scrollingState: any,
 *   getItemsFromGraphQLFn: (...args: any) => Record<any, any>,
 *   type: 'posts' | 'comments',
 * }} context
 */
const finiteScroll = async (context) => {
    const {
        itemSpec,
        page,
        scrollingState,
        getItemsFromGraphQLFn,
        type,
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
            // this is actually expected, the total count usually isn't the amount of actual loaded comments/posts
            return;
        }
    }
    // console.log('Got data from graphQl')

    // There is a rate limit in scrolling, we don;t know exactly how much
    // If you reach it, it will block you completely so it is necessary to wait more in scrolls
    // Seems the biggest block chance is when you are over 2000 items
    const { scrollWaitMillis } = itemSpec;
    if (oldItemCount > 1000) {
        const modulo = oldItemCount % 100;
        if (modulo >= 0 && modulo < 12) { // Every 100 posts: Wait random for user passed time with some randomization
            const waitMillis = Math.round(scrollWaitMillis + ((Math.random() * 10000) + 1000));
            log(itemSpec, `Sleeping for ${waitMillis / 1000} seconds to prevent getting rate limit error..`);
            await sleep(waitMillis);
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

/**
 * @template T
 * @typedef {T & { Apify: Apify, customData: any, request: Apify.Request }} PARAMS
 */

/**
 * Compile a IO function for mapping, filtering and outputing items.
 * Can be used as a no-op for interaction-only (void) functions on `output`.
 * Data can be mapped and filtered twice.
 *
 * Provided base map and filter functions is for preparing the object for the
 * actual extend function, it will receive both objects, `data` as the "raw" one
 * and "item" as the processed one.
 *
 * Always return a passthrough function if no outputFunction provided on the
 * selected key.
 *
 * @template RAW
 * @template {{ [key: string]: any }} INPUT
 * @template MAPPED
 * @template {{ [key: string]: any }} HELPERS
 * @param {{
 *  key: string,
 *  map?: (data: RAW, params: PARAMS<HELPERS>) => Promise<MAPPED>,
 *  output?: (data: MAPPED, params: PARAMS<HELPERS>) => Promise<void>,
 *  filter?: (obj: { data: RAW, item: MAPPED }, params: PARAMS<HELPERS>) => Promise<boolean>,
 *  input: INPUT,
 *  helpers: HELPERS,
 * }} params
 * @return {Promise<(data: RAW, args?: Record<string, any>) => Promise<void>>}
 */
const extendFunction = async ({
    key,
    output,
    filter,
    map,
    input,
    helpers,
}) => {
    /**
     * @type {PARAMS<HELPERS>}
     */
    const base = {
        ...helpers,
        Apify,
        customData: input.customData || {},
    };

    const evaledFn = (() => {
        // need to keep the same signature for no-op
        if (typeof input[key] !== 'string' || input[key].trim() === '') {
            return new vm.Script('({ item }) => item');
        }

        try {
            return new vm.Script(input[key], {
                lineOffset: 0,
                produceCachedData: false,
                displayErrors: true,
                filename: `${key}.js`,
            });
        } catch (e) {
            throw new Error(`"${key}" parameter must be a function`);
        }
    })();

    /**
     * Returning arrays from wrapper function split them accordingly.
     * Normalize to an array output, even for 1 item.
     *
     * @param {any} value
     * @param {any} [args]
     */
    const splitMap = async (value, args) => {
        const mapped = map ? await map(value, args) : value;

        if (!Array.isArray(mapped)) {
            return [mapped];
        }

        return mapped;
    };

    return async (data, args) => {
        const merged = { ...base, ...args };

        for (const item of await splitMap(data, merged)) {
            if (filter && !(await filter({ data, item }, merged))) {
                continue; // eslint-disable-line no-continue
            }

            const result = await (evaledFn.runInThisContext()({
                ...merged,
                data,
                item,
            }));

            for (const out of (Array.isArray(result) ? result : [result])) {
                if (output) {
                    if (out !== null) {
                        await output(out, merged);
                    }
                    // skip output
                }
            }
        }
    };
};

/**
 * Do a generic check when using Apify Proxy
 *
 * @typedef params
 * @property {any} [params.proxyConfig] Provided apify proxy configuration
 * @property {boolean} [params.required] Make the proxy usage required when running on the platform
 * @property {string[]} [params.blacklist] Blacklist of proxy groups, by default it's ['GOOGLE_SERP']
 * @property {boolean} [params.force] By default, it only do the checks on the platform. Force checking regardless where it's running
 * @property {string[]} [params.hint] Hint specific proxy groups that should be used, like SHADER or RESIDENTIAL
 *
 * @param {params} params
 * @returns {Promise<Apify.ProxyConfiguration | undefined>}
 */
const proxyConfiguration = async ({
    proxyConfig,
    required = true,
    force = Apify.isAtHome(),
    blacklist = ['GOOGLESERP'],
    hint = [],
}) => {
    const configuration = await Apify.createProxyConfiguration(proxyConfig);

    // this works for custom proxyUrls
    if (Apify.isAtHome() && required) {
        if (!configuration || (!configuration.usesApifyProxy && (!configuration.proxyUrls || !configuration.proxyUrls.length)) || !configuration.newUrl()) {
            throw new Error('\n=======\nYou must use Apify proxy or custom proxy URLs\n\n=======');
        }
    }

    // check when running on the platform by default
    if (force) {
        // only when actually using Apify proxy it needs to be checked for the groups
        if (configuration && configuration.usesApifyProxy) {
            if (blacklist.some((blacklisted) => (configuration.groups || []).includes(blacklisted))) {
                throw new Error(`\n=======\nThese proxy groups cannot be used in this actor. Choose other group or contact support@apify.com to give you proxy trial:\n\n*  ${blacklist.join('\n*  ')}\n\n=======`);
            }

            // specific non-automatic proxy groups like RESIDENTIAL, not an error, just a hint
            if (hint.length && !hint.some((group) => (configuration.groups || []).includes(group))) {
                Apify.utils.log.info(`\n=======\nYou can pick specific proxy groups for better experience:\n\n*  ${hint.join('\n*  ')}\n\n=======`);
            }
        }
    }

    return configuration;
};

/**
 * Patch input. Mutates the object
 *
 * @param {any} input
 */
const patchInput = (input) => {
    if (input) {
        if (typeof input.extendOutputFunction === 'string' && !input.extendOutputFunction.startsWith('async')) {
            // old extend output function, rewrite it to use the new format that will be
            // picked by the extendFunction helper
            Apify.utils.log.warning(`\n-------\nYour "extendOutputFunction" parameter is wrong, so it's being defaulted to a working one. Please change it to conform to the proper format or leave it empty\n-------\n`);
            input.extendOutputFunction = '';
        }

        if (typeof input.scrapePostsUntilDate === 'string' && input.scrapePostsUntilDate) {
            Apify.utils.log.warning(`\n-------\nYou are using "scrapePostsUntilDate" and it's deprecated. Prefer using "untilDate" as it works for both posts and comments`);
            input.untilDate = input.scrapePostsUntilDate;
        }
    }
};

/**
 * No handleRequestFunction errors
 *
 * @param {Apify.BrowserCrawler} crawler
 */
const patchLog = (crawler) => {
    const originalException = crawler.log.exception.bind(crawler.log);
    crawler.log.exception = (...args) => {
        if (!args?.[1]?.includes('handleRequestFunction')) {
            originalException(...args);
        }
    };
};

/**
 * @param {*} value
 * @returns
 */
const parseTimeUnit = (value) => {
    if (!value) {
        return null;
    }

    if (value === 'today' || value === 'yesterday') {
        return (value === 'today' ? moment() : moment().subtract(1, 'day')).startOf('day');
    }

    const [, number, unit] = `${value}`.match(/^(\d+)\s?(minute|second|day|hour|month|year|week)s?$/i) || [];

    if (+number && unit) {
        return moment().subtract(+number, unit);
    }

    return moment(value);
};

/**
 * @typedef MinMax
 * @property {number | string} [min]
 * @property {number | string} [max]
 */

/**
 * @typedef {ReturnType<typeof minMaxDates>} MinMaxDates
 */

/**
 * Generate a function that can check date intervals depending on the input
 * @param {MinMax} param
 */
const minMaxDates = ({ min, max }) => {
    const minDate = parseTimeUnit(min);
    const maxDate = parseTimeUnit(max);

    if (minDate && maxDate && maxDate.diff(minDate) < 0) {
        throw new Error(`Minimum date ${minDate.toISOString()} needs to be less than max date ${maxDate.toISOString()}`);
    }

    return {
        /**
         * cloned min date, if set
         */
        get minDate() {
            return minDate?.clone();
        },
        /**
         * cloned max date, if set
         */
        get maxDate() {
            return maxDate?.clone();
        },
        /**
         * compare the given date/timestamp to the time interval
         * @param {string | number} time
         */
        compare(time) {
            const base = moment(time);
            return (minDate ? minDate.diff(base) <= 0 : true) && (maxDate ? maxDate.diff(base) >= 0 : true);
        },
    };
};

module.exports = {
    getPageTypeFromUrl,
    getItemSpec,
    getCheckedVariable,
    log,
    query,
    finiteQuery,
    acceptCookiesDialog,
    singleQuery,
    parseCaption,
    extendFunction,
    minMaxDates,
    filterPushedItemsAndUpdateState,
    finiteScroll,
    shouldContinueScrolling,
    coalesce,
    proxyConfiguration,
    createGotRequester,
    patchLog,
    patchInput,
};
