const Apify = require('apify');
const _ = require('underscore');

const { scrapePosts, handlePostsGraphQLResponse, scrapePost } = require('./posts');
const { scrapeComments, handleCommentsGraphQLResponse } = require('./comments');
const { handleStoriesGraphQLResponse } = require('./stories');
const { scrapeDetails, handleDetailsGraphQLResponse } = require('./details');
const { searchUrls } = require('./search');
const { getItemSpec, parseExtendOutputFunction, getPageTypeFromUrl } = require('./helpers');
const { GRAPHQL_ENDPOINT, ABORT_RESOURCE_TYPES, ABORT_RESOURCE_URL_INCLUDES, ABORT_RESOURCE_URL_DOWNLOAD_JS, SCRAPE_TYPES, PAGE_TYPES } = require('./consts');
const { initQueryIds } = require('./query_ids');
const errors = require('./errors');
const { login } = require('./login');
const { LoginCookiesStore } = require('./cookies');

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
        includeHasStories = false,
        cookiesPerConcurrency = 1,
    } = input;

    const extendOutputFunction = parseExtendOutputFunction(input.extendOutputFunction);

    if (proxy && proxy.proxyUrls && proxy.proxyUrls.length === 0) delete proxy.proxyUrls;

    await initQueryIds();

    // We have to keep a state of posts/comments we already scraped so we don't push duplicates
    // TODO: Cleanup individual users/posts after all posts/comments are pushed
    const scrollingState = (await Apify.getValue('STATE-SCROLLING')) || {};
    const persistState = async () => {
        await Apify.setValue('STATE-SCROLLING', scrollingState);
    };
    setInterval(persistState, 5000);
    Apify.events.on('persistState', persistState);

    let maxConcurrency = 1000;

    const loginCookiesStore = new LoginCookiesStore(loginCookies, cookiesPerConcurrency, maxErrorCount);
    if (loginCookiesStore.usingLogin()) {
        maxConcurrency = loginCookiesStore.concurrency();
        Apify.utils.log.warning(`Cookies were used, setting maxConcurrency to ${maxConcurrency}. Count of available cookies: ${loginCookiesStore.cookiesCount()}!`);
    }

    try {
        if (Apify.isAtHome() && (proxy && !proxy.proxyUrls && !proxy.apifyProxyGroups)) throw errors.proxyIsRequired();
        if (!resultsType) throw errors.typeIsRequired();
        if (!Object.values(SCRAPE_TYPES).includes(resultsType)) throw errors.unsupportedType(resultsType);
        if (SCRAPE_TYPES.COOKIES === resultsType && (!loginUsername || !loginPassword)) throw errors.credentialsRequired();
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
        Apify.utils.log.warning('You are using Apify proxy but not residential group! It is very likely it will not work properly. Please contact support@apify.com for access to residential proxy.');
    }

    const proxyConfiguration = await Apify.createProxyConfiguration({
        proxyUrls: proxy && proxy.proxyUrls ? proxy.proxyUrls : undefined,
        groups: proxy && proxy.proxyUrls ? undefined : ['RESIDENTIAL'],
    });

    if (Apify.isAtHome() && !proxyConfiguration) {
        throw new Error("Can't use without proxies within the platform!");
    }

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

    const requestList = await Apify.openRequestList('request-list', requestListSources);

    /**
     * @type {Apify.PuppeteerGoto}
     */
    const gotoFunction = async ({ request, page, puppeteerPool, autoscaledPool }) => {
        loginCookiesStore.setPuppeteerPool(puppeteerPool); // get puppeteerPool instance
        loginCookiesStore.setAutoscaledPool(autoscaledPool); // get autoscaledPool instance
        await page.setBypassCSP(true);
        if (loginUsername && loginPassword) {
            await login(loginUsername, loginPassword, page);
            const cookies = await page.cookies();
            if (SCRAPE_TYPES.COOKIES === resultsType) {
                await Apify.pushData(cookies);
                return null;
            }
        }

        // TODO: Refactor to use https://sdk.apify.com/docs/api/puppeteer#puppeteerblockrequestspage-options
        // Keep in mind it requires more manual setup than page.setRequestInterception
        // await page.setRequestInterception(true);

        // const isScrollPage = resultsType === SCRAPE_TYPES.POSTS || resultsType === SCRAPE_TYPES.COMMENTS;
        // Apify.utils.log.debug(`Is scroll page: ${isScrollPage}`);

        // const { pageType } = request.userData;
        // Apify.utils.log.info(`Opening page type: ${pageType} on ${request.url}`);

        // page.on('request', (req) => {
        //     // We need to load some JS when we want to scroll
        //     // Hashtag & place pages seems to require even more JS allowed but this needs more research
        //     // Stories needs JS files
        //     const isJSBundle = req.url().includes('instagram.com/static/bundles/');
        //     const abortJSBundle = isScrollPage
        //         ? (!ABORT_RESOURCE_URL_DOWNLOAD_JS.some((urlMatch) => req.url().includes(urlMatch)) &&
        //             ![PAGE_TYPES.HASHTAG, PAGE_TYPES.PLACE].includes(pageType))
        //         : true

        //     if (
        //         ABORT_RESOURCE_TYPES.includes(req.resourceType())
        //         || ABORT_RESOURCE_URL_INCLUDES.some((urlMatch) => req.url().includes(urlMatch))
        //         || (isJSBundle && abortJSBundle && pageType !== PAGE_TYPES.STORY && !includeHasStories)
        //     ) {
        //         // Apify.utils.log.debug(`Aborting url: ${req.url()}`);
        //         return req.abort();
        //     }
        //     // Apify.utils.log.debug(`Processing url: ${req.url()}`);
        //     req.continue();
        // });
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

        page.on('response', async (response) => {
            const responseUrl = response.url();

            // Skip non graphql responses
            if (!responseUrl.startsWith(GRAPHQL_ENDPOINT)) return;

            // Wait for the page to parse it's data
            while (!page.itemSpec) await sleep(100);

            try {
                switch (resultsType) {
                    case SCRAPE_TYPES.POSTS:
                        return handlePostsGraphQLResponse({ page, response, scrollingState });
                    case SCRAPE_TYPES.COMMENTS:
                        return handleCommentsGraphQLResponse({ page, response, scrollingState });
                    case SCRAPE_TYPES.STORIES:
                        return handleStoriesGraphQLResponse({ page, response });
                    case SCRAPE_TYPES.DETAILS:
                        return handleDetailsGraphQLResponse({ page, response });
                }
            } catch (e) {
                Apify.utils.log.error(`Error happened while processing response: ${e.message}`);
                console.log(e.stack);
            }
        });

        page.on('requestfailed', (request) => {
            // Story data are not loaded if js fails
            if (ABORT_RESOURCE_URL_DOWNLOAD_JS.some((urlMatch) => request.url().includes(urlMatch) && resultsType === SCRAPE_TYPES.STORIES)) {
                page.storiesLoaded = false;
            }
        });

        // make sure the post page don't scroll outside when scrolling for comments,
        // otherwise it will hang forever
        await page.evaluateOnNewDocument((pageType) => {
            window.addEventListener('load', () => {
                document.body.style.overflow = pageType === 'post' ? 'hidden' : '';
                const cookieModalButton = document.querySelectorAll('[role="presentation"] [role="dialog"] button:first-of-type');

                if (cookieModalButton.length) {
                    cookieModalButton[0].click();
                }
            });
        }, request.userData.pageType);

        const response = await page.goto(request.url, {
            // itemSpec timeouts
            timeout: pageTimeout * 1000,
        });

        if (loginCookiesStore.usingLogin()) {
            try {
                const browser = page.browser();
                const viewerId = await page.evaluate(() => window._sharedData.config.viewerId);
                if (!viewerId) {
                    // choose other cookie from store or exit if no other available
                    loginCookiesStore.markAsBad(browser.process().pid);
                    if (loginCookiesStore.cookiesCount() > 0) {
                        puppeteerPool.retire(browser);
                        throw new Error('Failed to log in using cookies, they are probably no longer usable and you need to set new ones.');
                    } else {
                        Apify.utils.log.error('No login cookies available.');
                        process.exit(1);
                    }
                } else {
                    loginCookiesStore.markAsGood(browser.process().pid);
                }
            } catch (loginError) {
                Apify.utils.log.error(loginError);
                throw new Error('Page didn\'t load properly with login, retrying...');
            }
        }
        return response;
    };

    /**
     * @type {Apify.PuppeteerHandlePage}
     */
    const handlePageFunction = async ({ page, puppeteerPool, request, response }) => {
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
        // eslint-disable-next-line no-underscore-dangle
        await page.waitForFunction(() => (!window.__initialData.pending && window.__initialData && window.__initialData.data), { timeout: 20000 });
        // eslint-disable-next-line no-underscore-dangle
        const { pending, data } = await page.evaluate(() => window.__initialData);
        if (pending) throw new Error('Page took too long to load initial data, trying again.');
        if (!data || !data.entry_data) throw new Error('Page does not contain initial data, trying again.');
        const { entry_data: entryData } = data;

        if (entryData.LoginAndSignupPage) {
            await puppeteerPool.retire(page.browser());
            throw errors.redirectedToLogin();
        }

        const itemSpec = getItemSpec(entryData);
        // Passing the limit around
        itemSpec.limit = resultsLimit || 999999;
        itemSpec.scrapePostsUntilDate = scrapePostsUntilDate;
        itemSpec.input = input;
        itemSpec.scrollWaitSecs = scrollWaitSecs;

        let userResult = {};
        if (extendOutputFunction) {
            userResult = await page.evaluate((functionStr) => {
                // eslint-disable-next-line no-eval
                const f = eval(functionStr);
                return f();
            }, input.extendOutputFunction);
        }

        if (request.userData.label === 'postDetail') {
            const result = scrapePost(request, itemSpec, entryData);
            _.extend(result, userResult);

            await Apify.pushData(result);
        } else if (resultsType === SCRAPE_TYPES.STORIES) {
            page.itemSpec = itemSpec;
            // Wait for Data scraped from graphQL
            let sleepLength = 0;
            while (typeof page.storiesLoaded === 'undefined' && sleepLength < 10000) {
                await sleep(100);
                sleepLength += 100;
            }
            if (!page.storiesLoaded) throw new Error('JS needed for stories does not loaded properly, retrying...');
        } else {
            page.itemSpec = itemSpec;
            switch (resultsType) {
                case SCRAPE_TYPES.POSTS:
                    return scrapePosts({ page, request, itemSpec, entryData, input, scrollingState, puppeteerPool });
                case SCRAPE_TYPES.COMMENTS:
                    return scrapeComments({ page, itemSpec, entryData, scrollingState, puppeteerPool });
                case SCRAPE_TYPES.DETAILS:
                    return scrapeDetails({
                        input,
                        request,
                        itemSpec,
                        entryData,
                        page,
                        proxy,
                        userResult,
                        includeHasStories,
                    });
                default:
                    throw new Error('Not supported');
            }
        }
    };

    /**
     * @type {Apify.LaunchPuppeteerFunction}
     */
    const launchPuppeteerFunction = async (options) => {
        const browser = await Apify.launchPuppeteer({
            ...options,
        });

        const cookies = loginCookiesStore.randomCookie(browser.process().pid);
        if (cookies && cookies.length) {
            const page = await browser.newPage();
            await page.setCookie(...cookies);
        }

        return browser;
    };

    const requestQueue = await Apify.openRequestQueue();

    const crawler = new Apify.PuppeteerCrawler({
        requestList,
        requestQueue,
        gotoFunction,
        maxRequestRetries,
        puppeteerPoolOptions: {
            maxOpenPagesPerInstance: 1,
            retireInstanceAfterRequestCount: 30,
        },
        launchPuppeteerOptions: {
            stealth: true,
            useChrome: Apify.isAtHome(),
            stealthOptions: {
                addLanguage: false,
            },
            ignoreHTTPSErrors: true,
            args: ['--enable-features=NetworkService', '--ignore-certificate-errors'],
        },
        useSessionPool: true,
        proxyConfiguration: proxyConfiguration || undefined,
        launchPuppeteerFunction,
        maxConcurrency,
        handlePageTimeoutSecs: 300 * 60, // Ex: 5 hours to crawl thousands of comments
        handlePageFunction,

        // If request failed 4 times then this function is executed.
        handleFailedRequestFunction: async ({ request }) => {
            Apify.utils.log.error(`${request.url}: Request ${request.url} failed ${maxRequestRetries + 1} times, not retrying any more`);
            await Apify.pushData({
                '#debug': Apify.utils.createRequestDebugInfo(request),
                '#error': request.url,
            });
        },
    });

    await crawler.run();
    if (loginCookiesStore.invalidCookies().length > 0) Apify.utils.log.warning(`Invalid cookies: ${loginCookiesStore.invalidCookies().join('; ')}`);
}

module.exports = main;
