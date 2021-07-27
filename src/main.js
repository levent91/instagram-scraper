const Apify = require('apify');
const HeaderGenerator = require('header-generator');

const { resourceCache } = require('./resource-cache');
const { scrapePosts, handlePostsGraphQLResponse, scrapePost } = require('./posts');
const { scrapeComments, handleCommentsGraphQLResponse } = require('./comments');
const { scrapeStories } = require('./stories');
const { scrapeDetails } = require('./details');
const { searchUrls } = require('./search');
const helpers = require('./helpers');

const { getItemSpec, getPageTypeFromUrl, extendFunction } = helpers;
const { GRAPHQL_ENDPOINT, ABORT_RESOURCE_TYPES, ABORT_RESOURCE_URL_INCLUDES, SCRAPE_TYPES,
    ABORT_RESOURCE_URL_DOWNLOAD_JS, PAGE_TYPES, V1_ENDPOINT } = require('./consts');
const errors = require('./errors');
const { login, loginManager } = require('./login');

const { sleep, log } = Apify.utils;

Apify.main(async () => {
    /** @type {any} */
    const input = await Apify.getInput();
    const {
        proxy,
        resultsType,
        resultsLimit = 200,
        scrapePostsUntilDate,
        scrollWaitSecs = 15,
        pageTimeout = 60,
        maxRequestRetries,
        loginCookies,
        directUrls = [],
        loginUsername,
        maxErrorCount = 15,
        loginPassword,
        useStealth = false,
        useChrome,
        debugLog = false,
        includeHasStories = false,
        cookiesPerConcurrency = 1,
        blockMoreAssets = false,
        checkProxyIp = false, // For internal debug
    } = input;

    if (debugLog) {
        log.setLevel(log.LEVELS.DEBUG);
    }

    // We have to keep a state of posts/comments we already scraped so we don't push duplicates
    // TODO: Cleanup individual users/posts after all posts/comments are pushed
    /** @type {Record<string, any>} */
    const scrollingState = (await Apify.getValue('STATE-SCROLLING')) || {};
    const persistState = async () => {
        await Apify.setValue('STATE-SCROLLING', scrollingState);
    };
    Apify.events.on('persistState', persistState);

    let maxConcurrency = input.maxConcurrency || 1000;
    const logins = loginManager({
        loginCookies,
        maxErrorCount,
    });

    if (logins.loginCount()) {
        maxConcurrency = cookiesPerConcurrency;
        Apify.utils.log.warning(`Cookies were used, setting maxConcurrency to ${maxConcurrency}. Count of available cookies: ${logins.loginCount()}!`);
    }

    const proxyConfiguration = await helpers.proxyConfiguration({
        proxyConfig: proxy,
        hint: ['RESIDENTIAL'],
    });

    try {
        if (Apify.isAtHome() && !proxyConfiguration) throw errors.proxyIsRequired();
        if (!resultsType) throw errors.typeIsRequired();
        if (!Object.values(SCRAPE_TYPES).includes(resultsType)) throw errors.unsupportedType(resultsType);
        if (loginUsername && loginPassword && SCRAPE_TYPES.COOKIES !== resultsType) {
            Apify.utils.log.warning('You provided username and password but will be ignored');
        }
    } catch (error) {
        Apify.utils.log.info('--  --  --  --  --');
        Apify.utils.log.info(' ');
        Apify.utils.log.error('Run failed because the provided input is incorrect:');
        Apify.utils.log.error(error.message);
        Apify.utils.log.info(' ');
        Apify.utils.log.info('--  --  --  --  --');
        process.exit(1);
    }

    if (!logins.loginCount() && proxyConfiguration && !proxyConfiguration?.groups?.includes('RESIDENTIAL')) {
        Apify.utils.log.warning(`--------
        You are using Apify proxy but not the RESIDENTIAL group! It is very likely it will not work properly.
        Please contact support@apify.com for access to residential proxy.
--------`);
    }

    const doRequest = helpers.createGotRequester({
        proxyConfiguration,
    });

    let urls;
    if (resultsType === SCRAPE_TYPES.COOKIES) {
        if (loginUsername && loginPassword) {
            log.info('Will extract login information from username/password');
            urls = ['https://instagram.com'];
        } else {
            throw new Error('Result type is set to Cookies, but no username and password were provided');
        }
    } else if (Array.isArray(directUrls) && directUrls.length > 0) {
        Apify.utils.log.warning('Search is disabled when Direct URLs are used');
        urls = directUrls;
    } else if (resultsType !== SCRAPE_TYPES.COOKIES) {
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

    Apify.utils.log.info('Parsed start URLs:');
    console.dir(requestListSources);

    if (requestListSources.length === 0) {
        throw new Error('No URLs to process');
    }

    const requestQueue = await Apify.openRequestQueue();
    const requestList = await Apify.openRequestList('request-list', requestListSources);
    // keeps JS and CSS in a memory cache, since request interception disables cache
    const memoryCache = resourceCache([
        /static\/bundles/,
    ]);

    // TODO: Move everything here
    const extendOutputFunction = await extendFunction({
        output: async (data) => {
            await Apify.pushData(data);
        },
        input,
        key: 'extendOutputFunction',
        helpers: {
            helpers,
            logins,
        },
    });

    const extendScraperFunction = await extendFunction({
        output: async () => {}, // no-op
        input,
        key: 'extendScraperFunction',
        helpers: {
            requestQueue,
            helpers,
            logins,
        },
    });

    const headerGenerator = new HeaderGenerator({
        browsers: [
            { name: 'chrome', minVersion: 87 },
        ],
        devices: [
            'desktop',
        ],
        operatingSystems: process.platform === 'win32'
            ? ['windows']
            : ['linux'],
    });

    const crawler = new Apify.PuppeteerCrawler({
        requestList,
        requestQueue,
        persistCookiesPerSession: true,
        useSessionPool: true,
        preNavigationHooks: [async ({ request, page, session }, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';

            await page.setBypassCSP(true);

            if (loginUsername && loginPassword && resultsType === SCRAPE_TYPES.COOKIES) {
                await login(loginUsername, loginPassword, page);
                const cookies = await page.cookies();
                const storage = await page.evaluate(() => {
                    const extract = (storage) => {
                        return Object.getOwnPropertyNames(storage).reduce((out, key) => {
                            out[key] = storage[key];
                            return out;
                        });
                    };

                    return {
                        localStorage: extract(window.localStorage),
                        sessionStorage: extract(window.sessionStorage),
                        userAgent: navigator.userAgent,
                    };
                });

                await Apify.setValue('OUTPUT', {
                    cookies,
                    ...storage,
                });

                Apify.utils.log.info('\n-----------\n\nCookies and storage saved, check OUTPUT in the key value store\n\n-----------\n');
                return;
            }

            if (!(await logins.setCookie(page, session))) {
                Apify.utils.log.error('No login cookies available.');
                await crawler.autoscaledPool?.abort();
                return;
            }

            if (!checkProxyIp) {
                await Apify.utils.puppeteer.blockRequests(page, {
                    urlPatterns: [
                        '.ico',
                        '.mp4',
                        '.avi',
                        '.webp',
                        '.svg',
                    ],
                    extraUrlPatterns: ABORT_RESOURCE_URL_INCLUDES,
                });
            }

            // make sure the post page don't scroll outside when scrolling for comments,
            // otherwise it will hang forever. place the additionalData back
            await page.evaluateOnNewDocument((pageType) => {
                window.addEventListener('load', () => {
                    let loaded = false;
                    let tries = 0;

                    const patched = (path, data) => {
                        loaded = true;
                        window.__additionalData = {
                            [path]: { data },
                        };
                    };

                    const patch = () => {
                        for (const script of document.querySelectorAll('script')) {
                            if (script.innerHTML.includes('window.__additionalDataLoaded(')) {
                                try {
                                    window.__additionalDataLoaded = patched;
                                    window.eval(script.innerHTML);
                                } catch (e) {}
                            }
                        }

                        if (!loaded && tries++ < 30) {
                            setTimeout(patch, 300);
                        }
                    };

                    setTimeout(patch);

                    const closeModal = () => {
                        document.body.style.overflow = 'auto';

                        const cookieModalButton = document.querySelectorAll('[role="presentation"] [role="dialog"] button:first-of-type');

                        if (cookieModalButton.length) {
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
                        } else {
                            setTimeout(closeModal, 1000);
                        }
                    };

                    setTimeout(closeModal, 3000);
                });
            }, request.userData.pageType);

            // Request interception disables chromium cache, implement in-memory cache for
            // resources, will save literal MBs of traffic https://help.apify.com/en/articles/2424032-cache-responses-in-puppeteer
            await page.setRequestInterception(true);

            const { pageType } = request.userData;
            Apify.utils.log.info(`Opening page type: ${pageType} on ${request.url}`);

            // Old code to keep consumption low for Lafl
            if (blockMoreAssets) {
                console.log('Blocking more assets');
                const isScrollPage = resultsType === SCRAPE_TYPES.POSTS || resultsType === SCRAPE_TYPES.COMMENTS;
                page.on('request', (req) => {
                    // We need to load some JS when we want to scroll
                    // Hashtag & place pages seems to require even more JS allowed but this needs more research
                    // Stories needs JS files
                    const isJSBundle = req.url().includes('instagram.com/static/bundles/');
                    const abortJSBundle = isScrollPage
                        ? (!ABORT_RESOURCE_URL_DOWNLOAD_JS.some((urlMatch) => req.url().includes(urlMatch))
                            && ![PAGE_TYPES.HASHTAG, PAGE_TYPES.PLACE].includes(pageType))
                        : true;

                    if (
                        ABORT_RESOURCE_TYPES.includes(req.resourceType())
                        || ABORT_RESOURCE_URL_INCLUDES.some((urlMatch) => req.url().includes(urlMatch))
                        || (isJSBundle && abortJSBundle && pageType)
                    ) {
                        // log.debug(`Aborting url: ${req.url()}`);
                        return req.abort();
                    }
                    // log.debug(`Processing url: ${req.url()}`);
                    req.continue();
                });
            } else {
                // Main path, code made by Paulo, works well for worksloads that can be cached
                await memoryCache(page);
            }

            let waitingTries = 1000;

            page.on('response', async (response) => {
                try {
                    const responseUrl = response.url();

                    if (!page.itemSpec) {
                        // Wait for the page to parse it's data
                        while (!page.itemSpec && waitingTries-- > 0) {
                            await sleep(100);
                        }

                        if (waitingTries <= 0) {
                            // it was stuck forever
                            return;
                        }
                    }

                    if (responseUrl.startsWith(GRAPHQL_ENDPOINT)) {
                        switch (resultsType) {
                            case SCRAPE_TYPES.POSTS:
                                await handlePostsGraphQLResponse({
                                    page,
                                    response,
                                    scrollingState,
                                    extendOutputFunction,
                                });
                                break;
                            case SCRAPE_TYPES.COMMENTS:
                                await handleCommentsGraphQLResponse({
                                    page,
                                    response,
                                    scrollingState,
                                    extendOutputFunction,
                                });
                                break;
                            default:
                        }
                    } else if (responseUrl.startsWith(V1_ENDPOINT)) {
                        // mostly for locations
                        switch (resultsType) {
                            case SCRAPE_TYPES.POSTS: {
                                const entryData = await response.json();

                                await scrapePosts({
                                    additionalData: {},
                                    entryData,
                                    page,
                                    itemSpec: page.itemSpec,
                                    extendOutputFunction,
                                    resultsType,
                                    requestQueue,
                                    scrollingState,
                                    fromResponse: true,
                                });
                                break;
                            }
                            default:
                        }
                    }
                } catch (e) {
                    Apify.utils.log.debug(`Error happened while processing response`, {
                        url: request.url,
                        error: e.message,
                    });
                }
            });
        }],
        maxRequestRetries,
        launchContext: {
            stealth: useStealth,
            useChrome: typeof useChrome === 'boolean' ? useChrome : Apify.isAtHome(),
        },
        browserPoolOptions: {
            maxOpenPagesPerBrowser: 1,
            preLaunchHooks: [async (pageId, launchContext) => {
                const { request } = crawler.crawlingContexts.get(pageId);

                const locale = new URL(request.url).searchParams.get('hl');

                launchContext.launchOptions = {
                    ...launchContext.launchOptions,
                    bypassCSP: true,
                    ignoreHTTPSErrors: true,
                    devtools: input.debugLog,
                    locale,
                    args: [
                        `--user-agent=${headerGenerator.getHeaders({ locales: locale ? [locale] : [] })['user-agent']}`,
                        '--enable-features=NetworkService',
                        '--ignore-certificate-errors',
                        '--disable-blink-features=AutomationControlled', // removes webdriver from window.navigator
                    ],
                };
            }],
            postPageCloseHooks: [async (pageId, browserController) => {
                if (!browserController?.launchContext?.session?.isUsable()) {
                    await browserController.close();
                }
            }],
        },
        sessionPoolOptions: {
            sessionOptions: {
                maxErrorScore: logins.loginCount()
                    ? maxErrorCount
                    : 0.5,
            },
            // eslint-disable-next-line no-nested-ternary
            maxPoolSize: logins.loginCount() > 0
                ? logins.loginCount()
                : (resultsType === SCRAPE_TYPES.COOKIES ? 1 : undefined),
        },
        proxyConfiguration,
        maxConcurrency,
        handlePageTimeoutSecs: 300 * 60, // Ex: 5 hours to crawl thousands of comments
        handlePageFunction: async ({ page, request, response, session }) => {
            if (checkProxyIp) {
                await page.setBypassCSP(true);
                const { clientIp } = await page.evaluate(async () => {
                    return fetch('https://api.apify.com/v2/browser-info').then((res) => res.json());
                });
                console.log(`Opening page from IP: ${clientIp}`);
            }

            if (logins.hasSession(session)) {
                try {
                    await page.waitForFunction(() => {
                        return !!(window?._sharedData?.config?.viewerId);
                    }, { timeout: 15000 });

                    const viewerId = await page.evaluate(() => window?._sharedData?.config?.viewerId);

                    if (!viewerId) {
                        // choose other cookie from store or exit if no other available
                        logins.increaseError(session);

                        if (!logins.isUsable(session)) {
                            session.retire();
                            throw new Error('Failed to log in using cookies, they are probably no longer usable and you need to set new ones.');
                        }
                    } else {
                        logins.decreaseError(session);
                    }
                } catch (loginError) {
                    Apify.utils.log.exception(loginError, 'Login failed');
                    throw new Error('Page didn\'t load properly with login, retrying...');
                }
            }

            if (SCRAPE_TYPES.COOKIES === resultsType) return;

            // this can randomly happen
            if (!response) {
                throw new Error('Response is undefined');
            }

            if (response.status() === 404) {
                Apify.utils.log.error(`Page "${request.url}" does not exist.`);
                return;
            }
            const error = await page.$('body.p-error');
            if (error) {
                Apify.utils.log.error(`Page "${request.url}" is private and cannot be displayed.`);
                return;
            }

            await page.waitForFunction(() => {
                // eslint-disable-next-line no-underscore-dangle
                return (!(window?.__initialData?.pending)
                    && window?.__initialData?.data);
            }, { timeout: 20000 });

            try {
                // this happens in the evaluateOnNewDocument, so we wait a bit
                await page.waitForFunction(() => {
                    return (Object.keys(window?.__additionalData ?? {}).length > 0);
                }, { timeout: 10000 });
            } catch (e) {
                log.debug('Additional data', { url: request.url, e: e.message });
            }

            // eslint-disable-next-line no-underscore-dangle
            const { pending, data } = await page.evaluate(() => window.__initialData);
            const additionalData = await page.evaluate(() => {
                try {
                    return Object.values(window.__additionalData)[0].data;
                } catch (e) {
                    return {};
                }
            });

            if (pending) throw new Error('Page took too long to load initial data, trying again.');
            if (!data || !data.entry_data) throw new Error('Page does not contain initial data, trying again.');

            const { entry_data: entryData } = data;

            if (entryData.LoginAndSignupPage) {
                session.retire();
                throw errors.redirectedToLogin();
            }

            const itemSpec = getItemSpec(entryData, additionalData);
            // Passing the limit around
            itemSpec.limit = resultsLimit || 999999;
            itemSpec.scrapePostsUntilDate = scrapePostsUntilDate;
            itemSpec.input = input;
            itemSpec.scrollWaitSecs = scrollWaitSecs;

            // interact with page
            await extendScraperFunction(undefined, {
                page,
                request,
                itemSpec,
            });

            if (request.userData.label === 'postDetail') {
                const result = scrapePost(request, itemSpec, entryData, additionalData);

                await extendOutputFunction(result, {
                    label: 'post',
                });
            } else {
                page.itemSpec = itemSpec;
                try {
                    switch (resultsType) {
                        case SCRAPE_TYPES.POSTS:
                            await scrapePosts({
                                page,
                                itemSpec,
                                additionalData,
                                entryData,
                                scrollingState,
                                extendOutputFunction,
                                requestQueue,
                                resultsType,
                                fromResponse: false,
                            });
                            break;
                        case SCRAPE_TYPES.COMMENTS:
                            await scrapeComments({
                                page,
                                additionalData,
                                itemSpec,
                                entryData,
                                scrollingState,
                                extendOutputFunction,
                            });
                            break;
                        case SCRAPE_TYPES.DETAILS:
                            await scrapeDetails({
                                input,
                                request,
                                itemSpec,
                                data,
                                page,
                                extendOutputFunction,
                                includeHasStories,
                            });
                            break;
                        case SCRAPE_TYPES.STORIES:
                            await scrapeStories({
                                request,
                                page,
                                data,
                                extendOutputFunction,
                            });
                            break;
                        default:
                            throw new Error('Not supported');
                    }
                } catch (e) {
                    Apify.utils.log.debug('Retiring browser', { url: request.url });
                    session.retire();
                    throw e;
                }
            }
        },
        handleFailedRequestFunction: async ({ request, error }) => {
            Apify.utils.log.exception(error, `${request.url}: Request failed ${maxRequestRetries + 1} times, not retrying any more`);

            await Apify.pushData({
                '#debug': Apify.utils.createRequestDebugInfo(request),
                '#error': request.url,
            });
        },
    });

    if (!debugLog) {
        helpers.patchLog(crawler);
    }

    await crawler.run();
});
