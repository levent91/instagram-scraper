const Apify = require('apify');
const _ = require('underscore');

const { scrapePosts, handlePostsGraphQLResponse, scrapePost } = require('./posts');
const { scrapeComments, handleCommentsGraphQLResponse } = require('./comments');
const { scrapeStories } = require('./stories');
const { scrapeDetails } = require('./details');
const { searchUrls } = require('./search');
const { getItemSpec, getPageTypeFromUrl, extendFunction } = require('./helpers');
const { GRAPHQL_ENDPOINT, ABORT_RESOURCE_TYPES, ABORT_RESOURCE_URL_INCLUDES, SCRAPE_TYPES } = require('./consts');
const { initQueryIds } = require('./query_ids');
const errors = require('./errors');
const { login } = require('./login');

const { sleep } = Apify.utils;

async function main() {
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
        maxErrorCount,
        loginPassword,
        useStealth = false,
        useChrome,
        includeHasStories = false,
        cookiesPerConcurrency = 1,
    } = input;

    if (proxy && proxy.proxyUrls && proxy.proxyUrls.length === 0) delete proxy.proxyUrls;

    await initQueryIds();

    // We have to keep a state of posts/comments we already scraped so we don't push duplicates
    // TODO: Cleanup individual users/posts after all posts/comments are pushed
    const scrollingState = (await Apify.getValue('STATE-SCROLLING')) || {};
    const persistState = async () => {
        await Apify.setValue('STATE-SCROLLING', scrollingState);
    };
    Apify.events.on('persistState', persistState);

    let maxConcurrency = input.maxConcurrency || 1000;
    let loginCount = 0;

    if (loginCookies && loginCookies.length > 0) {
        maxConcurrency = cookiesPerConcurrency;
        loginCount = Array.isArray(loginCookies[0]) ? loginCookies.length : 1;
        Apify.utils.log.warning(`Cookies were used, setting maxConcurrency to ${maxConcurrency}. Count of available cookies: ${loginCount}!`);
    }

    try {
        if (Apify.isAtHome() && (!proxy || (!proxy.useApifyProxy && !proxy.proxyUrls))) throw errors.proxyIsRequired();
        if (!resultsType) throw errors.typeIsRequired();
        if (!Object.values(SCRAPE_TYPES).includes(resultsType)) throw errors.unsupportedType(resultsType);
        if (SCRAPE_TYPES.COOKIES === resultsType && (!loginUsername || !loginPassword)) throw errors.credentialsRequired();
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

    if (proxy && proxy.useApifyProxy && (!proxy.apifyProxyGroups || !proxy.apifyProxyGroups.includes('RESIDENTIAL'))) {
        Apify.utils.log.warning('You are using Apify proxy but not the RESIDENTIAL group! It is very likely it will not work properly. Please contact support@apify.com for access to residential proxy.');
    }

    const proxyConfiguration = await Apify.createProxyConfiguration(proxy);
    let urls;
    if (Array.isArray(directUrls) && directUrls.length > 0) {
        Apify.utils.log.warning('Search is disabled when Direct URLs are used');
        urls = directUrls;
    } else {
        urls = await searchUrls(input, proxyConfiguration ? proxyConfiguration.newUrl() : undefined);
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
        Apify.utils.log.info('No URLs to process');
        process.exit(0);
    }

    const requestQueue = await Apify.openRequestQueue();

    const requestList = await Apify.openRequestList('request-list', requestListSources);
    // keeps JS and CSS in a memory cache, since request interception disables cache
    const memoryCache = new Map();

    // TODO: Move everything here
    const extendOutputFunction = await extendFunction({
        output: async (data) => {
            await Apify.pushData(data);
        },
        input,
        key: 'extendOutputFunction',
        helpers: {

        },
    });

    const extendScraperFunction = await extendFunction({
        output: async () => {}, // no-op
        input,
        key: 'extendScraperFunction',
        helpers: {
            requestQueue,
        },
    });

    /**
     * @type {Apify.PuppeteerGoto}
     */
    const gotoFunction = async ({ request, page, puppeteerPool, session }) => {
        await page.setBypassCSP(true);

        await page.setViewport({
            ..._.sample([{
                width: 1920,
                height: 1080,
            }, {
                width: 1366,
                height: 768,
            }, {
                width: 1440,
                height: 900,
            }]),
            isMobile: false,
            deviceScaleFactor: _.sample([1, 2, 4]),
        });

        if (loginUsername && loginPassword && resultsType === SCRAPE_TYPES.COOKIES) {
            await login(loginUsername, loginPassword, page);
            const cookies = await page.cookies();

            await Apify.setValue('OUTPUT', cookies);

            Apify.utils.log.info('\n-----------\n\nCookies saved, check OUTPUT in the key value store\n\n-----------\n');
            return null;
        }

        if (loginCount > 0) {
            const cookies = session.getPuppeteerCookies('https://instagram.com');
            // page.cookies / getPuppeteerCookies have different settings for domain
            await page.setCookie(...cookies.map((s) => ({ ...s, domain: '.instagram.com' })));
        }

        await Apify.utils.puppeteer.blockRequests(page, {
            urlPatterns: [
                '.ico',
                '.png',
                '.mp4',
                '.avi',
                '.webp',
                '.jpg',
                '.jpeg',
                '.gif',
                '.svg',
            ],
            extraUrlPatterns: ABORT_RESOURCE_URL_INCLUDES,
        });

        // Request interception disables chromium cache, implement in-memory cache for
        // resources, will save literal MBs of traffic https://help.apify.com/en/articles/2424032-cache-responses-in-puppeteer
        await page.setRequestInterception(true);

        const { pageType } = request.userData;
        Apify.utils.log.info(`Opening page type: ${pageType} on ${request.url}`);

        page.on('request', async (req) => {
            // We need to load some JS when we want to scroll
            // Hashtag & place pages seems to require even more JS allowed but this needs more research
            // Stories needs JS files
            const isCacheable = req.url().includes('instagram.com/static/bundles');

            if (ABORT_RESOURCE_TYPES.includes(req.resourceType())) {
                // Apify.utils.log.debug(`Aborting url: ${req.url()}`);
                await req.abort();
                return;
            }

            if (isCacheable) {
                const url = req.url();
                if (memoryCache.has(url)) {
                    Apify.utils.log.debug('Has cache', { url });
                    await req.respond(memoryCache.get(url));
                    return;
                }
            }

            // Apify.utils.log.debug(`Processing url: ${req.url()}`);
            await req.continue();
        });

        page.on('response', async (response) => {
            const responseUrl = response.url();
            const isCacheable = responseUrl.includes('instagram.com/static/bundles');

            if (isCacheable && !memoryCache.has(responseUrl)) {
                Apify.utils.log.debug('Adding cache', { responseUrl });
                memoryCache.set(responseUrl, {
                    headers: response.headers(),
                    body: await response.buffer(),
                });
            }

            // Skip non graphql responses
            if (!responseUrl.startsWith(GRAPHQL_ENDPOINT)) return;

            // Wait for the page to parse it's data
            while (!page.itemSpec) await sleep(100);

            try {
                switch (resultsType) {
                    case SCRAPE_TYPES.POSTS:
                        await handlePostsGraphQLResponse({ page, response, scrollingState });
                        break;
                    case SCRAPE_TYPES.COMMENTS:
                        await handleCommentsGraphQLResponse({ page, response, scrollingState });
                        break;
                }
            } catch (e) {
                Apify.utils.log.error(`Error happened while processing response: ${e.message}`);
                console.log(e.stack);
            }
        });

        // make sure the post page don't scroll outside when scrolling for comments,
        // otherwise it will hang forever
        await page.evaluateOnNewDocument((pageType) => {
            window.addEventListener('load', () => {
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

        const response = await (async () => {
            try {
                return await page.goto(request.url, {
                    // itemSpec timeouts
                    timeout: pageTimeout * 1000,
                });
            } catch (e) {
                // this usually means that the proxy 100% failing and will keep trying until failing all retries
                if (loginCount > 0) {
                    session.markBad();
                } else {
                    session.retire();
                }
                await puppeteerPool.retire(page.browser());
                throw new Error('Page isn\'t loading, trying another proxy');
            }
        })();

        if (loginCount > 0) {
            try {
                await page.waitForFunction(() => {
                    return !!(window._sharedData
                        && window._sharedData.config
                        && window._sharedData.config.viewerId);
                }, { timeout: 15000 });

                const viewerId = await page.evaluate(() => window._sharedData.config.viewerId);

                if (!viewerId) {
                    // choose other cookie from store or exit if no other available
                    session.markBad();

                    if (!loginSessions.find((s) => s.isUsable())) {
                        await puppeteerPool.retire(page.browser());
                        throw new Error('Failed to log in using cookies, they are probably no longer usable and you need to set new ones.');
                    } else {
                        Apify.utils.log.error('No login cookies available.');
                        process.exit(1);
                    }
                } else {
                    session.markGood();
                }
            } catch (loginError) {
                Apify.utils.log.error(loginError);
                throw new Error('Page didn\'t load properly with login, retrying...');
            }
        }

        if (!response) {
            throw new Error('Response is invalid');
        }

        return response;
    };

    /**
     * @type {Apify.PuppeteerHandlePage}
     */
    const handlePageFunction = async ({ page, puppeteerPool, request, response, session }) => {
        if (SCRAPE_TYPES.COOKIES === resultsType) return;
        const proxyUrl = proxyConfiguration ? proxyConfiguration.newUrl(session.id) : undefined;

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

        // eslint-disable-next-line no-underscore-dangle
        await page.waitForFunction(() => (!window.__initialData.pending && window.__initialData && window.__initialData.data), { timeout: 20000 });
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
            if (loginCount > 0) {
                session.markBad();
            } else {
                session.retire();
            }
            // TODO: Bug in SDK puppeteerPool === undefined. Also this should not be used when session.retire works so remove later
            await puppeteerPool.retire(page.browser());
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

            await Apify.pushData(result);
        } else {
            page.itemSpec = itemSpec;
            try {
                switch (resultsType) {
                    case SCRAPE_TYPES.POSTS:
                        await scrapePosts({ page, request, itemSpec, entryData, input, scrollingState, puppeteerPool });
                        break;
                    case SCRAPE_TYPES.COMMENTS:
                        await scrapeComments({ page, request, additionalData, itemSpec, entryData, scrollingState, puppeteerPool });
                        break;
                    case SCRAPE_TYPES.DETAILS:
                        await scrapeDetails({
                            input,
                            request,
                            itemSpec,
                            data,
                            page,
                            proxy,
                            includeHasStories,
                            proxyUrl,
                        });
                        break;
                    case SCRAPE_TYPES.STORIES:
                        await scrapeStories({ request, page, data, proxyUrl });
                        break;
                    default:
                        throw new Error('Not supported');
                }
            } catch (e) {
                Apify.utils.log.debug('Retiring browser', { url: request.url });
                if (loginCount > 0) {
                    session.markBad();
                } else {
                    session.retire();
                }
                // TODO: Bug in SDK puppeteerPool === undefined. Also this should not be used when session.retire works so remove later
                await puppeteerPool.retire(page.browser());
                throw e;
            }
        }
    };

    /**
     * @type {Apify.LaunchPuppeteerFunction}
     */
    const launchPuppeteerFunction = async (options) => {
        return Apify.launchPuppeteer({
            ...options,
            stealth: useStealth,
            useChrome: typeof useChrome === 'boolean' ? useChrome : Apify.isAtHome(),
            ignoreHTTPSErrors: true,
            args: [
                '--enable-features=NetworkService',
                '--ignore-certificate-errors',
                '--disable-blink-features=AutomationControlled', // removes webdriver from window.navigator
            ],
            devtools: !Apify.isAtHome(),
        });
    };

    /**
     * @type {Apify.Session[]}
     */
    const loginSessions = [];

    /**
     * @param {Parameters<Apify.Session['setPuppeteerCookies']>[0]} cookies
     * @param {Apify.SessionPool} sessionPool
     */
    const setLoginSession = (cookies, sessionPool) => {
        const newSession = new Apify.Session({
            sessionPool,
            maxErrorScore: maxErrorCount,
            maxUsageCount: 50000,
        });

        newSession.setPuppeteerCookies(cookies, 'https://instagram.com');

        loginSessions.push(newSession);
    };

    const crawler = new Apify.PuppeteerCrawler({
        requestList,
        requestQueue,
        gotoFunction,
        maxRequestRetries,
        puppeteerPoolOptions: {
            useIncognitoPages: true,
            maxOpenPagesPerInstance: 1,
        },
        sessionPoolOptions: {
            // eslint-disable-next-line no-nested-ternary
            maxPoolSize: loginCount > 0 ? loginCount : (resultsType === SCRAPE_TYPES.COOKIES ? 1 : undefined),
            createSessionFunction(sessionPool) {
                if (loginCount > 0) {
                    if (!loginSessions.length) {
                        if (Array.isArray(loginCookies[0])) {
                            for (const cookies of loginCookies) {
                                setLoginSession(cookies, sessionPool);
                            }
                        } else {
                            setLoginSession(loginCookies, sessionPool);
                        }
                    }

                    return loginSessions.find((s) => s.isUsable());
                }

                return new Apify.Session({
                    sessionPool,
                });
            },
        },
        useSessionPool: true,
        proxyConfiguration: proxyConfiguration || undefined,
        launchPuppeteerFunction,
        maxConcurrency,
        handlePageTimeoutSecs: 300 * 60, // Ex: 5 hours to crawl thousands of comments
        handlePageFunction,
        handleFailedRequestFunction: async ({ request }) => {
            Apify.utils.log.error(`${request.url}: Request ${request.url} failed ${maxRequestRetries + 1} times, not retrying any more`);
            await Apify.pushData({
                '#debug': Apify.utils.createRequestDebugInfo(request),
                '#error': request.url,
            });
        },
    });

    await crawler.run();

    if (loginSessions.length > 0) {
        const invalid = loginSessions.reduce((count, session) => (count + (!session.isUsable() ? 1 : 0)), 0);

        if (invalid) {
            Apify.utils.log.warning(`Invalid cookies count: ${invalid}`);
        }
    }
}

module.exports = main;
