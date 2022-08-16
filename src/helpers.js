const Apify = require('apify');
const vm = require('vm');
const moment = require('moment');
const Puppeteer = require('puppeteer'); // eslint-disable-line no-unused-vars
const { gotScraping } = require('got-scraping');
const { PAGE_TYPES, PAGE_TYPE_PATH_REGEXES, GRAPHQL_ENDPOINT, SCRAPE_TYPES } = require('./consts');

const { sleep, log } = Apify.utils;

/**
 * Parses the __additionalData from script tags, as the
 * window property gets emptied after being consumed
 *
 * @param {Puppeteer.Page} page
 */
const getAdditionalData = (page) => {
    return page.evaluate(async () => {
        const script = [...document.querySelectorAll('script')].find((s) => /__additionalDataLoaded\(/.test(s.innerHTML));

        if (script) {
            try {
                return JSON.parse(script.innerHTML.split(/window\.__additionalDataLoaded\([^,]+?,/, 2)[1].slice(0, -2));
            } catch (e) {}
        }

        return {};
    });
};

/**
 * Contains almost the same shape as _sharedData, can indicate the page load
 * has finished loading
 *
 * @param {Puppeteer.Page} page
 */
const getEntryData = async (page) => {
    try {
        await page.waitForFunction(() => {
            // eslint-disable-next-line no-underscore-dangle
            return (window?._sharedData);
        }, { timeout: 30000 });
    } catch (e) {
        throw new Error('Page took too long to load initial data, trying again.');
    }

    return page.evaluate(() => window?._sharedData?.entry_data);
};

/**
 * fix instagram console errors, they forgot to add it to the window variable
 * click consent dialogs if they popup.
 *
 * makes the page always scrollable even with a modal showing
 *
 * accepts any cookie modal when they randomly pop-up
 *
 * @param {Puppeteer.Page} page
 */
const addLoopToPage = async (page) => {
    await page.evaluateOnNewDocument(() => {
        window.__bufferedErrors = window.__bufferedErrors || [];

        window.addEventListener('load', () => {
            window.onerror = () => {};

            const closeModal = () => {
                document.body.style.overflow = 'auto';

                const cookieModalButton = document.querySelectorAll('[role="presentation"] [role="dialog"] button:first-of-type');

                for (const button of cookieModalButton) {
                    if (!button.closest('#loginForm')) {
                        button.click();
                    } else {
                        const loginModal = button.closest('[role="presentation"]');
                        if (loginModal) {
                            loginModal.remove();
                        }
                    }
                }

                setTimeout(closeModal, 100);
            };

            closeModal();
        });
    });
};

/**
 * Creates a promise that can be resolved/rejected from the outside
 * Allows to query for the resolved status.
 *
 * Uses setTimeout to schedule the resolving/rejecting to the next
 * event loop, so things like Promise.race/all have a chance to attach
 * to them.
 */
const deferred = () => {
    /** @type {(val: any) => void} */
    let resolve = () => {};
    /** @type {(err?: Error) => void} */
    let reject = () => {};
    let resolved = false;
    let handled = false;
    let bail = 100;
    const promise = new Promise((_resolve, _reject) => {
        resolve = (val) => {
            if (!resolved) {
                resolved = true;
                setTimeout(() => {
                    _resolve(val);
                });
            }
        };
        reject = (err) => {
            if (!resolved) {
                resolved = true;
                const isHandled = () => {
                    if (!handled) {
                        bail--;
                        // this is needed because of page.on('response') racing condition
                        // if the emitter, that is synchronous, throws before we await/catch the promise
                        // the whole program crashes.
                        // On the other hand, it will make a promise that will never finish in rare cases,
                        // considerHandled() should always be raced against a timeout or something
                        if (bail > 0) {
                            setTimeout(isHandled, 100);
                        } else {
                            log.debug(`Promise was not handled in time`);
                        }
                        return;
                    }
                    _reject(err);
                };
                setTimeout(isHandled);
            }
        };
    });
    return {
        promise,
        considerHandled() {
            handled = true;
            return promise;
        },
        get resolved() {
            return resolved;
        },
        resolve,
        reject,
    };
};

/**
 * Translates word to have first letter uppercased so word will become Word
 * @param {string} word
 */
const uppercaseFirstLetter = (word) => {
    const uppercasedLetter = word.charAt(0).toUpperCase();
    const restOfTheWord = word.slice(1);
    return `${uppercasedLetter}${restOfTheWord}`;
};

/**
 * @param {string} jsonAddress
 */
const formatJSONAddress = (jsonAddress) => {
    if (!jsonAddress) return '';
    const address = (() => {
        try {
            return JSON.parse(jsonAddress);
        } catch (err) {
            return '';
        }
    })();

    return Object.keys(address).reduce((result, key) => {
        const parsedKey = key.split('_').map(uppercaseFirstLetter).join('');
        result[`address${parsedKey}`] = address[key];
        return result;
    }, {});
};

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
 * @param {string} url
 * @param {Puppeteer.Page} page
 * @param {(data: any) => any} nodeTransformationFunc
 * @param {string} logPrefix
 * @param {boolean} [isData]
 */
const query = async (
    url,
    page,
    nodeTransformationFunc,
    logPrefix,
    isData = true,
) => {
    let retries = 0;

    while (retries < 5) {
        try {
            const body = await page.evaluate(async ({ url, APP_ID, ASBD }) => {
                const res = await fetch(url, {
                    headers: {
                        'user-agent': window.navigator.userAgent,
                        accept: '*/*',
                        'accept-language': `${window.navigator.language};q=0.9`,
                        'x-asbd-id': ASBD,
                        'x-ig-app-id': APP_ID,
                        'x-ig-www-claim': sessionStorage.getItem('www-claim-v2') || '0',
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
            log.debug('query', { url, message: error.message });

            if (error.message.includes('429')) {
                log.warning(`${logPrefix} - Encountered rate limit error, waiting ${(retries + 1) * 10} seconds.`);

                await sleep((retries++ + 1) * 10000);
            } else {
                throw error;
            }
        }
    }

    log.warning(`${logPrefix} - Could not load more items`);

    return { nextPageCursor: null, data: [] };
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

    const [allowBtn] = await page.$x('//button[contains(., "cookie") and contains(., "Only")]');

    await Promise.all([
        page.waitForResponse(() => true),
        allowBtn.click(),
    ]);

    return true;
};

/**
 *
 * @param {string} hash
 * @param {Record<string, any>} variables
 * @param {(data: any) => any} nodeTransformationFunc
 * @param {number} limit
 * @param {Puppeteer.Page} page
 * @param {string} logPrefix
 */
const finiteQuery = async (hash, variables, nodeTransformationFunc, limit, page, logPrefix) => {
    if (!limit) {
        return [];
    }

    log.info(`${logPrefix} - Loading up to ${limit} items`);

    let hasNextPage = true;
    let endCursor = null;

    /** @type {any[]} */
    const results = [];
    do {
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
            logPrefix,
        );

        results.push(...data);

        if (nextPageCursor && results.length < limit) {
            endCursor = nextPageCursor;
            log.info(`${logPrefix} - So far loaded ${results.length} items`);
        } else {
            hasNextPage = false;
        }
    } while (hasNextPage && results.length < limit);

    log.info(`${logPrefix} - Finished loading ${results.length} items`);

    return results.slice(0, limit);
};

/**
 * @param {string} hash
 * @param {Record<string,any>} variables
 * @param {(data: any) => any} nodeTransformationFunc
 * @param {Puppeteer.Page} page
 * @param {string} logPrefix
 */
const singleQuery = async (hash, variables, nodeTransformationFunc, page, logPrefix) => {
    return query(
        `${GRAPHQL_ENDPOINT}?${queryHash({ hash, variables })}`,
        page,
        nodeTransformationFunc,
        logPrefix,
    );
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
 * @param {string} url
 */
const getPageTypeFromUrl = (url) => {
    // This should not fail as we check URL validity on input schema level
    // eslint-disable-next-line
    const { pathname } = new URL(url);
    for (const [pageType, regex] of Object.entries(PAGE_TYPE_PATH_REGEXES)) {
        if (pathname.match(regex)) {
            return PAGE_TYPES[pageType];
        }
    }
};

/**
 * Deduplicates an array of objects by a property
 * @template {Record<string, any>} T
 * @param {string} prop
 * @returns {(arr: T[]) => T[]}
 */
const dedupArrayByProperty = (prop) => (arr) => {
    const map = new Map();

    for (const item of arr) {
        if (item && prop in item) {
            map.set(item[prop], item);
        }
    }

    return Array.from(map.values());
};

/**
 * Takes page type and outputs variable that must be present in graphql query
 * @param {string} pageType
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
 * @param {string} caption
 */
const parseCaption = (caption) => {
    /** @type {string[]} */
    let hashtags = [];
    /** @type {string[]} */
    let mentions = [];

    if (caption) {
        // last part means non-spaced tags, like #some#tag#here
        // works with unicode characters. de-duplicates tags and mentions
        const HASHTAG_REGEX = /#([\S]+?)(?=\s|$|[#@])/gums;
        const MENTION_REGEX = /@([\S]+?)(?=\s|$|[#@])/gums;
        const clean = (regex) => [...new Set(([...caption.matchAll(regex)] || []).filter((s) => s[1]).map((s) => s[1].trim()))];
        hashtags = clean(HASHTAG_REGEX);
        mentions = clean(MENTION_REGEX);
    }

    return { hashtags, mentions };
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
                continue;
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
                log.info(`\n=======\nYou can pick specific proxy groups for better experience:\n\n*  ${hint.join('\n*  ')}\n\n=======`);
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
            if (input.extendOutputFunction) {
                log.warning(`\n-------\nYour "extendOutputFunction" parameter is wrong, so it's being defaulted to a working one. Please change it to conform to the proper format or leave it empty\n-------\n`);
            }
            input.extendOutputFunction = '';
        }

        if (!input.untilDate && typeof input.scrapePostsUntilDate === 'string' && input.scrapePostsUntilDate) {
            log.warning(`\n-------\nYou are using "scrapePostsUntilDate" and it's deprecated. Prefer using "untilDate" as it works for both posts and comments`);
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
    let minDate = parseTimeUnit(min);
    let maxDate = parseTimeUnit(max);

    if (minDate && maxDate && maxDate.diff(minDate) < 0) {
        log.warning(`Minimum date ( ${minDate.toString()} ) needs to be less than max date ( ${maxDate.toString()} ). Swapping input dates.`);
        const minDateValue = minDate;
        minDate = maxDate;
        maxDate = minDateValue;
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

/**
 * @template {string} C
 * @param {C} prop
 * @returns {<T extends { [C]: any }>(obj: T) => T[C] | never}
 */
const mapProp = (prop) => (obj) => obj?.[prop];

const dedupById = dedupArrayByProperty('id');
const mapNode = mapProp('node');

/**
 * @param {number} value
 */
const secondsToDate = (value) => {
    // eslint-disable-next-line no-nested-ternary
    return +value ? new Date(value * 1000).toISOString() : (value ? `${value}` : null);
};

/**
 * Extract `node` from the array
 *
 * @param {any[]} arr
 */
const arrayNodes = (arr) => (arr && Array.isArray(arr) ? arr : []).map(mapNode);

/**
 * @param {any[]} arr
 * @returns {string[]}
 */
const edgesToText = (arr) => {
    return arrayNodes(arr)
        .map(({ text }) => text?.trim())
        .filter(Boolean);
};

/**
 * Handles the response from page.on('response', ...)
 * @param { Puppeteer.HTTPResponse } response
 * @returns
 */

const handleResponse = async (response) => {
    const responseObject = {
        code: 0,
    };
    try {
        responseObject.code = await response.status();
        responseObject.data = await response.json();
    } catch (e) {
        responseObject.error = e;
    }
    return responseObject;
};

/**
 * Parses the script file if there is no valid XHR
 * @param { Puppeteer.Page } page
 * @returns
*/

const parsePageScript = async (page) => {
    const scripts = await page.$$eval('script', (scripts) => scripts.map((script) => script.innerHTML));
    for (const script of scripts) {
        // parse script with window._sharedData
        if (script.includes('window._sharedData')) {
            const parsedScript = script.replace('window._sharedData = ', '').slice(0, -1);
            return eval(`(${parsedScript})`).entry_data?.ProfilePage?.[0]?.graphql?.user;
        } if (script.includes('highlight_reel_count')) {
            const json = script.split(`"result":`)?.[1]?.slice(0, -15);
            return eval(`(${JSON.parse(json).response})`).data.user;
        } if (script.includes('HasteSupportData')) {
            log.debug('Found HasteSupportData, no shareddata nor highlight_reel_count');
        }
    }
};

/**
 * Generates random wait durations
 * @param { Number } min
 * @param { Number } max
 * @returns { Number }
*/

const randomScrollWaitDuration = (min, max) => {
    return Math.floor(Math.random() * (max - min + 1) + min);
};

const sanitizeInput = (input) => {
    // If user inputs posts -> posts (invalid), we can convert it to posts -> details which is a valid
    const areUrlsPosts = input.directUrls?.length > 0
        && input.directUrls.every((url) => getPageTypeFromUrl(url) === PAGE_TYPES.POST);
    if (areUrlsPosts && (input.resultsType === SCRAPE_TYPES.POSTS || input.resultsType === SCRAPE_TYPES.DETAILS)) {
        input.resultsType = SCRAPE_TYPES.POST_DETAIL;
    }
};

module.exports = {
    getPageTypeFromUrl,
    randomScrollWaitDuration,
    getCheckedVariable,
    queryHash,
    parseCaption,
    extendFunction,
    minMaxDates,
    proxyConfiguration,
    createGotRequester,
    patchLog,
    patchInput,
    uppercaseFirstLetter,
    formatJSONAddress,
    singleQuery,
    query,
    finiteQuery,
    acceptCookiesDialog,
    deferred,
    addLoopToPage,
    getEntryData,
    getAdditionalData,
    dedupArrayByProperty,
    dedupById,
    mapNode,
    mapProp,
    arrayNodes,
    edgesToText,
    secondsToDate,
    handleResponse,
    parsePageScript,
    sanitizeInput,
};
