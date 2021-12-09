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
    /** @type {any} */
    const input = await Apify.getInput();
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
        hint: !usingLoginCookies ? ['RESIDENTIAL'] : [],
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

    if (Apify.isAtHome()) {
        if (!usingLoginCookies && proxyConfiguration?.usesApifyProxy && proxyConfiguration?.groups?.includes('RESIDENTIAL') === false) {
            log.warning(`
--------
        You are using Apify proxy but not the RESIDENTIAL group! It is very likely it will not work properly.
        Please contact support@apify.com for access to residential proxy.
--------`);
        }

        if (usingLoginCookies && proxyConfiguration?.groups?.includes('RESIDENTIAL') === true) {
            log.warning(`
--------
        RESIDENTIAL proxy group when using login cookies is not advised as the location of the IP will keep changing.
        If the login cookies are getting logged out, try changing to a datacenter proxy.
--------`);
        }
    }

    const doRequest = helpers.createGotRequester({
        proxyConfiguration: proxyConfiguration?.usesApifyProxy === true ? await Apify.createProxyConfiguration({
            groups: ['RESIDENTIAL'],
            countryCode: 'US',
        }) : proxyConfiguration,
    });

    /** @type {string[]} */
    let urls = [];

    if (Array.isArray(directUrls) && directUrls.length > 0) {
        log.warning('Search is disabled when Direct URLs are used');
        urls = directUrls;
    } else {
        // don't search when doing cookies
        urls = await searchUrls(input, doRequest);
    }

    const requestListSources = urls.map((url) => ({
        url,
        userData: {
            // TODO: This should be the only page type we ever need, remove the one from entryData
            pageType: getPageTypeFromUrl(url),
        },
    }));

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
