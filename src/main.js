const Apify = require('apify');

const { createAddPost } = require('./posts');
const { createAddProfile } = require('./details');
const { searchUrls, createHashtagSearch, createLocationSearch } = require('./search');
const helpers = require('./helpers');

const { getPageTypeFromUrl } = helpers;

const consts = require('./consts');

const { SCRAPE_TYPES } = consts;
const errors = require('./errors');

const LoginScraper = require('./scraper-login');
const PublicScraper = require('./scraper-public');

const { log } = Apify.utils;

Apify.main(async () => {
    throw `******\nINSTAGRAM SCRAPER DOESN'T WORK!\nInstagram changed layout of their page and most input types stopped working\n`
    + `We decided to completely disable this scraper until this issue is resolved to prevent further spending of your credits\n`
    + `Some use-cases should be enabled today or tomorrow, most till the end of the week\n`
    + `We will notify you on email once this actor is enabled again\n`
    + `*****`;

    /** @type {any} */
    const input = await Apify.getInput();

    // login cookies can be array of objects (single cookies) or array of arrays of objects (multiple cookies)
    if (input.loginCookies?.length > 0) {
        log.warning(`Input contains full loginCookies. This causes problems with login. Will use only the sessionid cookie`);
        // 2022-06-02: Seems Instagram stopped working with all cookies, we must use only sessionid cookies
        if (Array.isArray(input.loginCookies[0])) {
            input.loginCookies = input.loginCookies.map((cookies) =>
                cookies.filter((cookie) => cookie.name === 'sessionid'),
            );
        } else {
            input.loginCookies = input.loginCookies.filter((cookie) => cookie.name === 'sessionid');
        }
    }

    const {
        proxy,
        resultsType = 'posts',
        loginCookies,
        directUrls = [],
        debugLog = false,
        cookiesPerConcurrency = 1,
    } = input;

    if (debugLog) {
        log.setLevel(log.LEVELS.DEBUG);
    }

    let maxConcurrency = input.maxConcurrency || 1000;
    const usingLoginCookies = loginCookies?.length > 0;

    if (usingLoginCookies) {
        maxConcurrency = cookiesPerConcurrency;
        log.warning(`Cookies were used, setting maxConcurrency to ${maxConcurrency}. Count of available cookies: ${Array.isArray(loginCookies[0]) ? loginCookies.length : 1}!`);
    }

    const proxyConfiguration = await helpers.proxyConfiguration({
        proxyConfig: proxy,
    });

    try {
        if (Apify.isAtHome() && !proxyConfiguration) throw errors.proxyIsRequired();
        if (!resultsType) throw errors.typeIsRequired();
        if (!Object.values(SCRAPE_TYPES).includes(resultsType)) throw errors.unsupportedType(resultsType);
    } catch (error) {
        log.info('--  --  --  --  --');
        log.info(' ');
        log.error('Run failed because the provided input is incorrect:');
        log.error(error.message);
        log.info(' ');
        log.info('--  --  --  --  --');
        throw new Error('Run aborted');
    }

    if (Apify.isAtHome() && proxyConfiguration?.usesApifyProxy === true) {
        if (!usingLoginCookies && proxyConfiguration?.groups?.includes('RESIDENTIAL') === false) {
            log.warning(`
--------
        You are using Apify proxy but not the RESIDENTIAL group! It is very likely it will not work properly.
        Please contact support@apify.com for access to residential proxy.
--------`);
        }

        if (usingLoginCookies && proxyConfiguration?.groups?.includes('RESIDENTIAL') === true) {
            throw new Error(`
--------
        RESIDENTIAL proxy group when using login cookies is not advised as the location of the IP will keep changing.
        Change to a datacenter proxy.
--------`);
        }
    }

    const doRequest = helpers.createGotRequester({
        proxyConfiguration: proxyConfiguration?.usesApifyProxy === true ? await Apify.createProxyConfiguration({
            groups: ['RESIDENTIAL'],
            countryCode: 'US',
        }) : proxyConfiguration,
    });

    /** @type {Apify.RequestOptions[]} */
    let requestListSources = [];

    if (Array.isArray(directUrls) && directUrls.length > 0) {
        log.warning('Search is disabled when Direct URLs are used');

        requestListSources = directUrls.map((url) => ({
            url,
            userData: {
                pageType: getPageTypeFromUrl(url),
            },
        }));
    } else {
        // don't search when doing cookies
        const searchResults = await searchUrls(input, doRequest);

        requestListSources = searchResults.map(({ searchTerm, searchType, url }) => {
            const pageType = getPageTypeFromUrl(url);

            return {
                url,
                userData: {
                    searchTerm,
                    searchType,
                    pageType,
                },
            };
        });
    }

    if (requestListSources.length === 0) {
        throw new Error('No URLs to process');
    }

    if (!usingLoginCookies && resultsType === SCRAPE_TYPES.STORIES) {
        throw new Error('Scraping stories require login information');
    }

    const requestQueue = await Apify.openRequestQueue();
    const requestList = await Apify.openRequestList('request-list', requestListSources);

    helpers.patchInput(input);

    const minMaxDate = helpers.minMaxDates({
        max: input.fromDate,
        min: input.untilDate,
    });

    if (minMaxDate?.maxDate) {
        log.info(`Getting content older than ${minMaxDate.maxDate.toISOString()}`);
    }

    if (minMaxDate?.minDate) {
        log.info(`Getting content until ${minMaxDate.minDate.toISOString()}`);
    }

    /** @type {Record<string, any>} */
    const scrollingState = (await Apify.getValue('STATE-SCROLLING')) || {};

    const persistState = async () => {
        await Apify.setValue('STATE-SCROLLING', scrollingState);
    };

    Apify.events.on('migrating', persistState);
    Apify.events.on('aborting', persistState);

    const extendOutputFunction = await helpers.extendFunction({
        filter: async ({ item }) => {
            // compare timestamp on posts or comments
            const attachedDate = item?.timestamp
                ?? item?.taken_at_timestamp;

            return attachedDate
                ? minMaxDate.compare(attachedDate)
                : true;
        },
        output: async (data, { context, ig }) => {
            if (!data) {
                return;
            }

            const { crawler } = context;
            await Apify.pushData(crawler.setDebugData(context, ig, data));
        },
        input,
        key: 'extendOutputFunction',
        helpers: {
            scrollingState,
            helpers,
            doRequest,
        },
    });

    const addProfile = createAddProfile(requestQueue);
    const addPost = createAddPost(requestQueue);
    const addLocation = createLocationSearch(requestQueue);
    const addHashtag = createHashtagSearch(requestQueue);

    const extendScraperFunction = await helpers.extendFunction({
        output: async () => {}, // no-op
        input,
        key: 'extendScraperFunction',
        helpers: {
            scrollingState,
            requestQueue,
            helpers,
            addProfile,
            addPost,
            addLocation,
            addHashtag,
            doRequest,
        },
    });

    await new (
        usingLoginCookies
            ? LoginScraper
            : PublicScraper
    )({
        input,
        proxyConfiguration,
        requestList,
        requestQueue,
        scrollingState,
        minMaxDate,
        extendScraperFunction,
        extendOutputFunction,
    }).run();
});
