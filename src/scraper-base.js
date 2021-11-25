const HeaderGenerator = require('header-generator');
const Apify = require('apify');
// eslint-disable-next-line no-unused-vars
const Puppeteer = require('puppeteer');

const { resourceCache } = require('./resource-cache');
const helpers = require('./helpers');
const { formatSinglePost, formatIGTVVideo, formatDisplayResources } = require('./details');

const consts = require('./consts');

const {
    ABORT_RESOURCE_URL_INCLUDES, SCRAPE_TYPES, PAGE_TYPES,
    QUERY_IDS: {
        profileFollowersQueryId,
        taggedPostsQueryId,
        profileFollowingQueryId,
        profilePublicStories,
        postLikesQueryId,
        postQueryId,
    },
} = consts;
const errors = require('./errors');

const { sleep, log } = Apify.utils;

class BaseScraper extends Apify.PuppeteerCrawler {
    /**
     * @param {consts.Options} options
     */
    constructor(options) {
        const {
            requestList,
            requestQueue,
            ...rest
        } = options;

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

        // keeps JS and CSS in a memory cache, since request interception disables cache
        const memoryCache = resourceCache([
            /static\/bundles/,
        ]);

        // !MUTATING INPUT!
        rest.input.resultsLimit = rest.input.resultsLimit || 999999;

        super({
            requestList,
            requestQueue,
            persistCookiesPerSession: false,
            useSessionPool: true,
            postNavigationHooks: [async ({ page }) => {
                if (!page.isClosed()) {
                    await page.bringToFront();
                }
            }],
            preNavigationHooks: [async ({ request, page }, gotoOptions) => {
                gotoOptions.waitUntil = 'domcontentloaded';

                const locale = new URL(request.url).searchParams.get('hl');

                await page.setUserAgent(headerGenerator.getHeaders({ locales: locale ? [locale] : [] })['user-agent']);
                await page.setBypassCSP(true);

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

                // fix instagram console errors, they forgot to add it to the window variable
                // click consent dialogs if they popup. fix their page
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

                const { pageType } = request.userData;
                log.info(`Opening page type: ${pageType} on ${request.url}`);

                await memoryCache(page);
            }],
            maxRequestRetries: options.input.maxRequestRetries,
            launchContext: {
                launchOptions: {
                    headless: Apify.isAtHome(), // for local debugging mainly
                },
            },
            browserPoolOptions: {
                maxOpenPagesPerBrowser: 1,
                preLaunchHooks: [async (pageId, launchContext) => {
                    const { request } = this.crawlingContexts.get(pageId);

                    const locale = new URL(request.url).searchParams.get('hl');

                    launchContext.launchOptions = {
                        ...launchContext.launchOptions,
                        bypassCSP: true,
                        ignoreHTTPSErrors: true,
                        devtools: rest.debugLog,
                        locale,
                    };
                }],
                postPageCloseHooks: [async (pageId, browserController) => {
                    if (browserController?.launchContext?.session?.isUsable() === false) {
                        log.debug('Session not usable, closing browser');
                        await browserController.close();
                    }
                }],
            },
            proxyConfiguration: options.proxyConfiguration,
            handlePageTimeoutSecs: 300 * 60, // Ex: 5 hours to crawl thousands of comments
            handlePageFunction: (context) => {
                return this.defaultHandler(context); // don't lose 'this' context, but don't bind uselessly
            },
            handleFailedRequestFunction: async ({ request, error }) => {
                log.exception(error, `${request.url}: Request failed ${request.retryCount} times, not retrying any more`);

                await Apify.pushData({
                    '#debug': Apify.utils.createRequestDebugInfo(request),
                    '#error': error.message,
                    '#url': request.url,
                });
            },
        });

        /** @type {consts.Options['scrollingState']} */
        this.scrollingState = options.scrollingState;

        /**
         * @type {Omit<consts.Options, 'requestQueue' | 'requestList'>}
         */
        this.options = rest;
        /**
         * @type {Map<string, { username: string }>}
         */
        this.users = new Map();
    }

    /**
     * @param {consts.PuppeteerContext} context
     */
    async defaultHandler(context) {
        const { page, request, response, session } = context;
        const { extendScraperFunction, input } = this.options;

        // this can randomly happen
        if (!response) {
            throw new Error('Response is undefined');
        }

        if (response.status() === 404) {
            request.noRetry = true;
            throw errors.doesntExist();
        }

        const error = await page.$('body.p-error');
        if (error) {
            log.error(`Page "${request.url}" is private and cannot be displayed.`);
            return;
        }

        try {
            await page.waitForFunction(() => {
                // eslint-disable-next-line no-underscore-dangle
                return (window?.__initialData?.pending === false && !!(window?.__initialData?.data?.entry_data));
            }, { timeout: 30000 });
        } catch (e) {
            throw new Error('Page took too long to load initial data, trying again.');
        }

        // eslint-disable-next-line no-underscore-dangle
        const entryData = await page.evaluate(() => window.__initialData.data.entry_data);

        if (entryData.LoginAndSignupPage || entryData.LandingPage) {
            session.retire();
            throw errors.redirectedToLogin();
        }

        const additionalData = await page.evaluate(async () => {
            return new Promise((resolve) => {
                let tries = 10;

                const searchScripts = () => {
                    const script = [...document.querySelectorAll('script')].find((s) => /__additionalDataLoaded\(/.test(s.innerHTML));

                    if (script) {
                        try {
                            return resolve(JSON.parse(script.innerHTML.split(/window\.__additionalDataLoaded\([^,]+?,/, 2)[1].slice(0, -2)));
                        } catch (e) { }
                    }

                    if (tries-- > 0) {
                        setTimeout(searchScripts, 100);
                    } else {
                        resolve({});
                    }
                };

                setTimeout(searchScripts);
            });
        });

        const itemSpec = this.getItemSpec({ entryData, additionalData });

        const { pageType } = itemSpec;

        itemSpec.label = `[${helpers.uppercaseFirstLetter(pageType)} ${itemSpec.name || itemSpec.tagName || request.url}]`;

        if (pageType === PAGE_TYPES.CHALLENGE) {
            this.challengePage(context);
            throw errors.challengePage();
        }

        if (pageType === PAGE_TYPES.AGE || pageType === PAGE_TYPES.DONTEXIST) {
            request.noRetry = true;

            switch (pageType) {
                case PAGE_TYPES.AGE:
                    throw errors.agePage();
                case PAGE_TYPES.DONTEXIST:
                    throw errors.doesntExist();
                default:
                    // make eslint happy
                    return;
            }
        }

        /** @type {consts.IGData} */
        const igData = {
            additionalData,
            entryData,
            itemSpec,
        };

        try {
            switch (input.resultsType) {
                case SCRAPE_TYPES.POSTS:
                    return this.scrapePosts(context, igData);
                case SCRAPE_TYPES.COMMENTS:
                    if (pageType !== PAGE_TYPES.POST) {
                        request.noRetry = true;
                        throw errors.notPostPage();
                    }

                    return this.scrapeComments(context, igData);
                case SCRAPE_TYPES.DETAILS:
                    return this.scrapeDetails(context, igData);
                case SCRAPE_TYPES.STORIES:
                    return this.scrapeStories(context, igData);
                case SCRAPE_TYPES.POST_DETAIL:
                    return this.scrapePostDetail(context, igData);
                default:
                    throw new Error('Not supported');
            }
        } catch (e) {
            log.debug('Retiring browser', { url: request.url });
            session.retire();
            throw e;
        } finally {
            // interact with page
            await extendScraperFunction(undefined, {
                ...context,
                label: 'HANDLE',
            });
        }
    }

    /**
     * Load has_public_story from separate XHR request
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    async loadPublicStories(context, ig) {
        const { request, page } = context;
        const { entryData } = ig;

        if (!entryData.ProfilePage) {
            request.noRetry = true;
            throw new Error('Not a profile page');
        }

        const userId = entryData.ProfilePage[0].graphql.user.id;

        try {
            return await helpers.singleQuery(
                profilePublicStories,
                {
                    user_id: userId,
                    include_chaining: false,
                    include_reel: false,
                    include_suggested_users: false,
                    include_logged_out_extras: true,
                    include_highlight_reels: true,
                    include_live_status: true,
                },
                (d) => d,
                page,
                'Stories',
            );
        } catch (e) {
            throw new Error('XHR for hasPublicStory not loaded correctly.');
        }
    }

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    async getTaggedPosts(context, ig) {
        const { itemSpec } = ig;
        const { page } = context;

        if (!itemSpec.userId) {
            return undefined;
        }

        return helpers.singleQuery(
            taggedPostsQueryId,
            {
                id: itemSpec.userId,
                first: 50,
            },
            (data) => data?.user?.edge_user_to_photos_of_you?.edges?.map(({ node }) => formatSinglePost(node)),
            page,
            'Tagged post',
        );
    }

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     * @param {Record<string, any>} data
     */
    setDebugData(context, ig, data) {
        const { request } = context;
        const { itemSpec } = ig;

        return {
            '#debug': {
                ...Apify.utils.createRequestDebugInfo(request),
                ...itemSpec,
                input: this.options.input,
            },
            ...data,
        };
    }

    /**
     * @param {consts.IGData} data
     */
    getItemSpec(data) {
        const { entryData } = data;

        if (entryData.Challenge) {
            return {
                pageType: PAGE_TYPES.CHALLENGE,
            };
        }

        if (entryData.HttpGatedContentPage) {
            return {
                pageType: PAGE_TYPES.AGE,
            };
        }

        if (entryData.HttpErrorPage) {
            return {
                pageType: PAGE_TYPES.DONTEXIST,
            };
        }

        log.info('unsupported page', entryData);

        throw errors.unsupportedPage();
    }

    /**
     *
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    async getProfileFollowedBy(context, ig) {
        const { page } = context;
        const { likedByLimit } = this.options.input;
        const { itemSpec } = ig;

        if (!likedByLimit) return undefined;

        log.info(`Loading users current profile followed by (limit ${likedByLimit} items).`);

        /**
         * @param {Record<string, any>} data
         */
        const nodeTransformationFunction = (data) => {
            if (!data.user) throw new Error('"Followed by" GraphQL query does not contain user object');
            if (!data.user.edge_followed_by) throw new Error('"Followed by" GraphQL query does not contain edge_followed_by object');
            const followedBy = data.user.edge_followed_by;
            const pageInfo = followedBy.page_info;
            const endCursor = pageInfo.end_cursor;
            const users = followedBy.edges.map((followedByItem) => {
                const { node } = followedByItem;

                return {
                    id: node.id,
                    full_name: node.full_name,
                    username: node.username,
                    profile_pic_url: node.profile_pic_url,
                    is_private: node.is_private,
                    is_verified: node.is_verified,
                };
            });

            return { nextPageCursor: endCursor, data: users };
        };

        const variables = {
            id: itemSpec.userId,
            include_reel: false,
            fetch_mutual: false,
        };

        return helpers.finiteQuery(
            profileFollowersQueryId,
            variables,
            nodeTransformationFunction,
            likedByLimit,
            page,
            '[profile followed by]',
        );
    }

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    async getPostLikes(context, ig) {
        const { likedByLimit = 0 } = this.options.input;

        if (!likedByLimit || likedByLimit === 0) return [];

        const { page } = context;
        const { itemSpec } = ig;

        log.info(`Loading users who liked the post (limit ${likedByLimit} items).`);

        /**
         * @param {Record<string, any>} data
         */
        const nodeTransformationFunction = (data) => {
            if (!data.shortcode_media) throw new Error('Liked by GraphQL query does not contain shortcode_media');
            if (!data.shortcode_media.edge_liked_by) throw new Error('Liked by GraphQL query does not contain edge_liked_by');
            const likedBy = data.shortcode_media.edge_liked_by;
            const pageInfo = likedBy.page_info;
            const endCursor = pageInfo.end_cursor;
            const likes = likedBy.edges.map((like) => {
                const { node } = like;
                return {
                    id: node.id,
                    full_name: node.full_name,
                    username: node.username,
                    profile_pic_url: node.profile_pic_url,
                    is_private: node.is_private,
                    is_verified: node.is_verified,
                };
            });
            return { nextPageCursor: endCursor, data: likes };
        };

        const variables = {
            shortcode: itemSpec.id,
            include_reel: false,
        };

        return helpers.finiteQuery(
            postLikesQueryId,
            variables,
            nodeTransformationFunction,
            likedByLimit,
            page,
            '[post likes]',
        );
    }

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    async getProfileFollowing(context, ig) {
        const { followingLimit } = this.options.input;
        const { page } = context;
        const { itemSpec } = ig;

        log.info(`Loading users current profile follows (limit ${followingLimit} items).`);

        /**
         * @param {Record<string, any>} data
         */
        const nodeTransformationFunction = (data) => {
            if (!data.user) throw new Error('"Following" GraphQL query does not contain user object');
            if (!data.user.edge_follow) throw new Error('"Following" GraphQL query does not contain edge_follow object');
            const following = data.user.edge_follow;
            const pageInfo = following.page_info;
            const endCursor = pageInfo.end_cursor;
            const users = following.edges.map((followingItem) => {
                const { node } = followingItem;
                return {
                    id: node.id,
                    full_name: node.full_name,
                    username: node.username,
                    profile_pic_url: node.profile_pic_url,
                    is_private: node.is_private,
                    is_verified: node.is_verified,
                };
            });
            return { nextPageCursor: endCursor, data: users };
        };

        const variables = {
            id: itemSpec.userId,
            include_reel: false,
            fetch_mutual: false,
        };

        return helpers.finiteQuery(
            profileFollowingQueryId,
            variables,
            nodeTransformationFunction,
            followingLimit,
            page,
            '[profile following]',
        );
    }

    /**
     * @param {consts.PuppeteerContext} context
     * @param {any[]} posts
     */
    async expandOwnerDetails(context, posts) {
        const { page } = context;

        // We have to require it here because of circular dependency
        log.info(`Owner details - Expanding details for ${posts.length} items.`);

        const defaultVariables = { child_comment_count: 3, fetch_comment_count: 40, parent_comment_count: 24, has_threaded_comments: true };
        const transformFunction = (data) => {
            return data.shortcode_media.owner;
        };
        const transformedPosts = [];
        for (let i = 0; i < posts.length; i++) {
            log.info(`Owner details - Expanding owner details of post ${i + 1}/${posts.length}`);

            const ownerId = posts[i].ownerId
                ?? posts[i]?.['#debug']?.postOwnerId;

            if (!ownerId) {
                transformedPosts.push(posts[i]);
                // eslint-disable-next-line no-continue
                continue;
            }

            const newPost = { ...posts[i] };

            if (this.users.has(ownerId)) {
                newPost.ownerUsername = this.users.get(ownerId).username;
                newPost.owner = this.users.get(ownerId);
                transformedPosts.push(newPost);
                // eslint-disable-next-line no-continue
                continue;
            }

            try {
                const owner = await helpers.singleQuery(
                    postQueryId,
                    { shortcode: posts[i]['#debug'].shortcode, ...defaultVariables },
                    transformFunction,
                    page,
                    'Owner details',
                );
                this.users.set(ownerId, owner);
                newPost.ownerUsername = owner.username;
                newPost.owner = owner;
            } catch (e) {
                log.debug(`${e.message}`, posts[i]);
            }
            transformedPosts.push(newPost);
            await sleep(500);
        }

        log.info(`Owner details - Details for ${posts.length} items expanded.`);

        return transformedPosts;
    }

    /**
     * @param {string} id
     */
    initScrollingState(id) {
        const { scrollingState } = this;

        if (!scrollingState[id]) {
            /** @type {consts.Options['scrollingState']['']} */
            const newState = {
                hasNextPage: true,
                allDuplicates: false,
                reachedLastPostDate: false,
                ids: {},
            };
            scrollingState[id] = newState;
            return newState;
        }

        return scrollingState[id];
    }

    /**
     * @param {any[]} items
     * @param {string} id
     * @param {(items: any[], position: number) => any[]} parsingFn
     * @param {(item: any) => Promise<void>} outputFn
     */
    async filterPushedItemsAndUpdateState(items, id, parsingFn, outputFn) {
        const { minMaxDate, input: { resultsLimit = 0 } } = this.options;

        if (!resultsLimit || !items?.length) {
            return;
        }

        const state = this.initScrollingState(id);

        const currentCount = () => Object.keys(state.ids).length;
        const parsedItems = parsingFn(items, currentCount());
        let itemsPushed = 0;

        const isAllOutOfTimeRange = parsedItems.every(({ timestamp }) => {
            return (minMaxDate.minDate?.isAfter(timestamp) === true)
                || (minMaxDate.maxDate?.isBefore(timestamp) === true);
        });

        for (const item of parsedItems) {
            if (currentCount() >= resultsLimit) {
                log.info(`Reached user provided limit of ${resultsLimit} results, stopping...`);
                break;
            }

            if (minMaxDate.compare(item.timestamp)) {
                if (!state.ids[item.id]) {
                    await outputFn(item);
                    itemsPushed++;
                    state.ids[item.id] = true;
                } else {
                    // Apify.utils.log.debug(`Item: ${item.id} was already pushed, skipping...`);
                }
            }
        }

        if (isAllOutOfTimeRange && currentCount() > 0) {
            log.info('Max date has been reached');
            state.reachedLastPostDate = true;
        }

        // We have to tell the state if we are going though duplicates so it knows it should still continue scrolling
        if (itemsPushed === 0) {
            state.allDuplicates = true;
        } else {
            state.allDuplicates = false;
        }
    }

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    async formatProfileOutput(context, ig) {
        const { includeTaggedPosts } = this.options.input;
        const following = await this.getProfileFollowing(context, ig);
        const followedBy = await this.getProfileFollowedBy(context, ig);
        const taggedPosts = includeTaggedPosts ? await this.getTaggedPosts(context, ig) : [];

        const { entryData } = ig;

        const data = entryData.ProfilePage[0].graphql.user;

        return {
            ...this.getDebugData(context, ig),
            id: data.id,
            username: data.username,
            fullName: data.full_name,
            biography: data.biography,
            externalUrl: data.external_url,
            externalUrlShimmed: data.external_url_linkshimmed,
            followersCount: data.edge_followed_by.count,
            followsCount: data.edge_follow.count,
            hasChannel: data.has_channel,
            highlightReelCount: data.highlight_reel_count,
            isBusinessAccount: data.is_business_account,
            joinedRecently: data.is_joined_recently,
            businessCategoryName: data.business_category_name,
            private: data.is_private,
            verified: data.is_verified,
            profilePicUrl: data.profile_pic_url,
            profilePicUrlHD: data.profile_pic_url_hd,
            facebookPage: data.connected_fb_page,
            igtvVideoCount: data.edge_felix_video_timeline.count,
            latestIgtvVideos: data.edge_felix_video_timeline ? data.edge_felix_video_timeline.edges.map(formatIGTVVideo) : [],
            postsCount: data.edge_owner_to_timeline_media.count,
            latestPosts: data.edge_owner_to_timeline_media ? data.edge_owner_to_timeline_media.edges.map((edge) => edge.node).map(formatSinglePost) : [],
            following,
            followedBy,
            taggedPosts,
            hasPublicStory: data.has_public_story,
        };
    }

    /**
     * @param {Puppeteer.HTTPResponse} response
     */
    isValidResponse(response) {
        const status = response.status();

        if (status === 429) {
            throw new Error('rateLimited');
        }

        if (status !== 200) {
            throw new Error(`Got error status while scrolling: ${status}. Retrying...`);
        }

        // a text/html here means a redirect to login
        return response.headers()['content-type']?.includes('application/json') === true;
    }

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     * @param {'comments' | 'posts'} type
     * @returns {Promise<boolean>} Returns false when it shouldn't loop anymore
     */
    async finiteScroll(context, ig, type) {
        const { page } = context;
        const { itemSpec } = ig;
        const { input: { resultsLimit = 0 } } = this.options;

        if (!resultsLimit) {
            return false;
        }

        const state = this.initScrollingState(itemSpec.id);

        try {
            if (page.isClosed()) {
                return false;
            }
        } catch (e) {
            // Target closed error
            return false;
        }

        const oldItemCount = Object.keys(state.ids).length;

        // console.log('Starting load more fn')
        await page.keyboard.press('PageUp');

        const selectors = {
            morePosts: 'article ~ div > div > button',
            moreComments: 'li > div > button',
        };

        try {
            // wait for any selector on page
            await page.waitForSelector(Object.values(selectors).join(','), {
                timeout: 10000,
            });
        } catch (e) { }

        // comments scroll up with button
        const elements = await (async () => {
            if (type === 'posts') {
                return page.$$(selectors.morePosts);
            }

            if (type === 'comments') {
                return page.$$(selectors.moreComments);
            }

            throw new Error('Type has to be "posts" or "comments"!');
        })();

        if (elements.length > 0) {
            const [button] = elements;

            try {
                const clicked = await Promise.all([
                    button.click(),
                    helpers.acceptCookiesDialog(page),
                    page.waitForRequest(() => true, { timeout: 10000 }).catch(() => null),
                ]);

                if (!clicked[2]) {
                    log.debug('no response after click for 10s');

                    return false;
                }
            } catch (e) {
                log.debug('finiteScroll error', { error: e.message, stack: e.stack });
                // "Node is either not visible or not an HTMLElement" from button.click(), would propagate and
                // break the whole recursion needlessly
            }
        } else {
            log.debug('zero clickable elements');
            if (type === 'comments') {
                // the button is gone when done loading
                return false;
            }
        }

        await sleep(1500);

        /**
         * posts scroll down
         */
        if (type === 'posts') {
            const scrolled = await Promise.all([
                page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)),
                page.waitForRequest(() => true, { timeout: 5000 }).catch(() => null),
            ]);

            if (!scrolled[1]) {
                log.debug('no response scrolling for 5s');

                return false;
            }
        }

        if (type === 'comments') {
            // delete nodes to make DOM less bloated
            await page.evaluate(() => {
                document.querySelectorAll('.EtaWk > ul > ul').forEach((s) => s.remove());
            });
        }

        if (state.reachedLastPostDate) {
            log.debug('reached last post date');
            return false;
        }

        const itemsScrapedCount = Object.keys(state.ids).length;
        const reachedLimit = itemsScrapedCount >= resultsLimit;

        if (reachedLimit) {
            log.warning(`Reached max ${type} limit: ${resultsLimit}. Finishing scrolling...`);
            return false;
        }

        if (itemsScrapedCount !== oldItemCount) {
            log.debug(`count ${itemsScrapedCount} != old count ${oldItemCount}`);
            return true;
        }

        if (state.allDuplicates) {
            log.debug('all duplicates, its scrolling again');
            return true;
        }

        return true;
    }

    /**
     * @param {consts.PuppeteerContext} context
     * @param {string} message
     */
    throwNonImplemented({ request }, message) {
        request.noRetry = true;
        throw new Error(message);
    }

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    async scrapePosts(context, ig) {
        this.throwNonImplemented(context, 'Scraping post is not implemented');
    }

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    async scrapeStories(context, ig) {
        this.throwNonImplemented(context, 'Scraping stories is not implemented');
    }

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    async scrapePostDetail(context, ig) {
        this.throwNonImplemented(context, 'Scraping post detail is not implemented');
    }

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    formatPlaceOutput(context, ig) {}

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    formatHashtagOutput(context, ig) {}

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    async formatPostOutput(context, ig) {}

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    async getOutputFromEntryData(context, ig) {
        const { pageType } = ig.itemSpec;

        switch (pageType) {
            case PAGE_TYPES.PLACE:
                return this.formatPlaceOutput(context, ig);
            case PAGE_TYPES.PROFILE:
                return this.formatProfileOutput(context, ig);
            case PAGE_TYPES.HASHTAG:
                return this.formatHashtagOutput(context, ig);
            case PAGE_TYPES.POST:
                return this.formatPostOutput(context, ig);
            default:
                throw new Error('Not supported');
        }
    }

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    async scrapeDetails(context, ig) {
        const { extendOutputFunction } = this.options;
        const { includeHasStories } = this.options.input;

        let hasPublicStories;

        if (includeHasStories) hasPublicStories = await this.loadPublicStories(context, ig);

        const output = await this.getOutputFromEntryData(context, ig);

        if (includeHasStories) output.hasPublicStory = hasPublicStories?.user?.has_public_story ?? false;

        await extendOutputFunction(output, {
            ...context,
            ig,
            label: 'details',
        });
    }

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    async scrapeComments(context, ig) {
        const { page } = context;

        // Check if the page loaded properly
        try {
            await page.waitForSelector('.EtaWk', { timeout: 15000 });
        } catch (e) {
            throw new Error(`Post page didn't load properly, opening again`);
        }
    }

    /**
     * @param {Array<Record<string, any>>} comments
     * @param {Record<string, any>} itemSpec
     * @param {number} currentScrollingPosition
     */
    parseCommentsForOutput(comments, itemSpec, currentScrollingPosition) {
        return comments.map((item, index) => {
            return {
                id: item.node.id,
                postId: itemSpec.id,
                text: item.node.text,
                position: index + currentScrollingPosition + 1,
                timestamp: new Date(parseInt(item.node.created_at, 10) * 1000).toISOString(),
                ownerId: item?.node?.owner?.id ?? null,
                ownerIsVerified: item?.node?.owner?.is_verified ?? null,
                ownerUsername: item?.node?.owner?.username ?? null,
                ownerProfilePicUrl: item?.node?.owner?.profile_pic_url ?? null,
            };
        });
    }

    /**
     * @param {keyof typeof PAGE_TYPES} pageType
     * @param {Record<string, any>} data
     */
    getPostsFromGraphQL(pageType, data) {
        const timeline = (() => {
            switch (pageType) {
                case PAGE_TYPES.PLACE:
                    return data?.location?.edge_location_to_media;
                case PAGE_TYPES.PROFILE:
                    return data?.user?.edge_owner_to_timeline_media;
                case PAGE_TYPES.HASHTAG:
                    return data?.hashtag?.edge_hashtag_to_media;
                default:
                    throw new Error('Not supported');
            }
        })();

        /** @type {any[]} */
        const postItems = timeline?.edges ?? [];
        /** @type {boolean} */
        const hasNextPage = timeline?.page_info?.has_next_page ?? false;
        /** @type {number} */
        const postsCount = timeline?.count ?? postItems.length;

        return {
            posts: postItems,
            hasNextPage,
            postsCount,
        };
    }

    /**
     * @param {any[]} posts
     * @param {any} itemSpec
     * @param {number} currentScrollingPosition
     */
    parsePostsForOutput(posts, itemSpec, currentScrollingPosition) {
        return posts.map((item, index) => {
            const post = formatSinglePost(item.node);

            return {
                queryTag: itemSpec.tagName,
                queryUsername: itemSpec.userUsername,
                queryLocation: itemSpec.locationName,
                position: currentScrollingPosition + 1 + index,
                ...post,
                locationId: post.locationId ?? itemSpec.locationId ?? null,
                locationName: post.locationName ?? itemSpec.locationName ?? null,
            };
        });
    }

    /**
     * Takes type of page and data loaded through GraphQL and outputs
     * correct list of comments.
     * @param {Record<string, any>} data GraphQL data
     */
    getCommentsFromGraphQL(data) {
        const { shortcode_media } = data;

        const timeline = shortcode_media && shortcode_media.edge_media_to_parent_comment;
        /** @type {any[]} */
        const commentItems = timeline ? timeline.edges.reverse() : [];
        /** @type {number | null} */
        const commentsCount = timeline ? timeline.count : null;
        /** @type {boolean} */
        const hasNextPage = timeline ? timeline.page_info.has_next_page : false;

        return {
            comments: commentItems,
            hasNextPage,
            commentsCount,
        };
    }

    async run() {
        const { extendScraperFunction, input } = this.options;

        await extendScraperFunction(undefined, {
            label: 'START',
            crawler: this,
        });

        if (!input.debugLog) {
            helpers.patchLog(this);
        }

        await super.run();

        await extendScraperFunction(undefined, {
            label: 'FINISH',
            crawler: this,
        });
    }

    /**
     * No-op by default.
     * @param {consts.PuppeteerContext} [context]
     */
    challengePage(context) { }
}

module.exports = BaseScraper;
