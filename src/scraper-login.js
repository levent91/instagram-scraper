const Apify = require('apify');
// eslint-disable-next-line no-unused-vars
const Puppeteer = require('puppeteer');
const delay = require('delayable-idle-abort-promise').default;

const PublicScraper = require('./scraper-public');

const helpers = require('./helpers');
const { loginManager } = require('./login');
const consts = require('./consts');
const errors = require('./errors');

const {
    V1_ENDPOINT,
    GRAPHQL_ENDPOINT,
    QUERY_IDS: {
        profileStories,
    },
    PAGE_TYPES,
} = consts;

const { log } = Apify.utils;

class LoginScraper extends PublicScraper {
    /**
     * @param {consts.Options} options
     */
    constructor(options) {
        super(options);

        /** @type {Awaited<ReturnType<typeof loginManager>>} */
        this.logins = null;

        this.preNavigationHooks.push(async (context) => {
            const { session, page, request } = context;

            await this.logins.setCookie(page, session);
        });

        this.postNavigationHooks.push(async (context) => {
            const { page, session, request } = context;
            const { logins } = this;

            if (this.logins.hasSession(session)) {
                try {
                    // takes a while to load on slower proxies
                    await page.waitForFunction(() => {
                        return !!(window?._sharedData.config.viewerId);
                    }, { timeout: 30000 });

                    const viewerId = await page.evaluate(() => window._sharedData.config.viewerId);

                    if (!viewerId) {
                        // choose other cookie from store or exit if no other available
                        logins.increaseError(session);

                        if (!logins.isUsable(session)) {
                            const error = new Error('Failed to log in using cookies, they are probably no longer usable and you need to set new ones.');
                            this.autoscaledPool?.reject?.(error);
                            throw error; // safety net
                        }
                    } else {
                        logins.decreaseError(session);
                    }
                } catch (loginError) {
                    log.exception(loginError, 'session failed(l-error)');
                    throw new Error('Page didn\'t load properly with input cookie, retrying...');
                }
            }
        });

        this.sessionPoolOptions.maxPoolSize = this.options.input.cookiesPerConcurrency || 1;
        this.sessionPoolOptions.sessionOptions = {
            maxErrorScore: 1000,
            maxUsageCount: 99999999,
        };
    }

    /**
     * Takes type of page and data loaded through GraphQL and outputs
     * correct list of comments.
     * @param {Record<string, any>} data GraphQL data
     */
    getCommentsFromGraphQL(data) {
        const { comments, comment_count, has_more_comments, has_more_headload_comments } = data;

        if (!comments?.length) {
            return super.getCommentsFromGraphQL(data);
        }

        return {
            comments,
            hasNextPage: has_more_headload_comments || has_more_comments,
            commentsCount: comment_count,
        };
    }

    /**
     *
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    async scrapeComments(context, ig) {
        await super.scrapeComments(context, ig);

        const { pageData } = ig;
        const { extendOutputFunction, extendScraperFunction } = this.options;
        const { page, request } = context;

        const state = this.initScrollingState(pageData.id);

        const control = delay(300000);
        const defer = helpers.deferred();

        /**
         * @param {{ comments: any[], commentsCount: number }} timeline
         * @param {Puppeteer.HTTPResponse} [response]
         */
        const pushComments = (timeline, response = undefined, isGraphQL = false) => {
            return this.filterPushedItemsAndUpdateState(
                timeline.comments,
                pageData.id,
                (items, position) => {
                    return isGraphQL
                        ? super.parseCommentsForOutput(items, pageData, position)
                        : this.parseCommentsForOutput(items, pageData, position);
                },
                async (item) => {
                    await extendOutputFunction(item, {
                        context,
                        response,
                        ig,
                        label: 'comment',
                    });
                },
                {
                    label: this.logLabel(context, ig),
                    total: timeline.commentsCount,
                },
            );
        };

        const checkedVariable = helpers.getCheckedVariable(pageData.pageType);

        page.on('response', async (response) => {
            try {
                const responseUrl = response.url();

                if (response.request().method() === 'GET') {
                    if (responseUrl.startsWith(GRAPHQL_ENDPOINT)) {
                        if (!this.isValidResponse(response)) {
                            return defer.reject(new Error('Login'));
                        }

                        // Skip queries for other stuff then posts
                        if (!responseUrl.includes(checkedVariable) || !responseUrl.includes('%22first%22')) {
                            log.debug('Skipping', { responseUrl, checkedVariable });
                            return;
                        }

                        // If it fails here, it means that the error was caught in the finite scroll anyway so we just don't do anything
                        const data = await (async () => {
                            try {
                                return await response.json();
                            } catch (e) {
                                log.debug(e.message);
                            }
                        })();

                        if (!data) {
                            return;
                        }

                        control.postpone();

                        const timeline = super.getCommentsFromGraphQL(data.data);

                        if (state.hasNextPage && !timeline.hasNextPage) {
                            log.debug('no hasNextPage from graphql');
                            state.hasNextPage = false;
                        }

                        await pushComments(timeline, response, true);
                    }

                    if (responseUrl.startsWith(V1_ENDPOINT) && responseUrl.includes('/comments/')) {
                        if (!this.isValidResponse(response)) {
                            return defer.reject(new Error('Login'));
                        }

                        // If it fails here, it means that the error was caught in the finite scroll anyway so we just don't do anything
                        const data = await (async () => {
                            try {
                                return await response.json();
                            } catch (e) {
                                log.debug(e.message);
                            }
                        })();

                        if (!data) {
                            return;
                        }

                        if (data?.comments?.length) {
                            control.postpone();

                            const timeline = this.getCommentsFromGraphQL(data);

                            if (state.hasNextPage && !timeline.hasNextPage) {
                                log.debug('no hasNextPage');
                                state.hasNextPage = false;
                            }

                            await pushComments(timeline, response);
                        }
                    }
                }
            } catch (e) {
                // throwing here would be the death of the run
                log.debug(`Error happened while processing response`, {
                    url: request.url,
                    error: e.message,
                });

                if (e.message === 'rateLimited') {
                    return defer.reject(errors.rateLimited());
                }

                if (e.message === 'Login') {
                    return defer.reject(errors.redirectedToLogin());
                }

                if (!e.message.includes('Network.')) {
                    return defer.reject(e);
                }
            } finally {
                await extendScraperFunction(undefined, {
                    context,
                    ig,
                    label: 'RESPONSE',
                    response,
                });
            }
        });

        try {
            await control.run([
                defer.considerHandled(),
                (async () => {
                    while (state.hasNextPage && !defer.resolved) {
                        const ret = await this.finiteScroll(
                            context,
                            ig,
                            'comments',
                        );

                        if (!ret) {
                            break;
                        }
                    }
                })(),
            ]);
        } catch (e) {
            context.session.retire();
            throw e;
        } finally {
            try {
                page.removeAllListeners('response');
                control.abort();
            } catch (e) {}
        }
    }

    /**
     * @param {Array<Record<string, any>>} comments
     * @param {Record<string, any>} pageData
     * @param {number} currentScrollingPosition
     */
    parseCommentsForOutput(comments, pageData, currentScrollingPosition) {
        try {
            return (comments ?? []).map((item, index) => {
                return {
                    id: `${item.pk}`,
                    postId: `${pageData.id}`,
                    shortCode: `${pageData.id}`,
                    text: item.text,
                    position: index + currentScrollingPosition + 1,
                    timestamp: new Date(parseInt(item.created_at_utc, 10) * 1000).toISOString(),
                    ownerIsVerified: item?.user?.is_verified ?? null,
                    ownerProfilePicUrl: item?.owner?.profile_pic_url ?? null,
                    ...this.formatEndpointUser(item.user),
                };
            });
        } catch (e) {
            return super.parseCommentsForOutput(comments, pageData, currentScrollingPosition);
        }
    }

    /**
     * Takes type of page and it's initial loaded data and outputs
     * correct list of posts based on the page type.
     *
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    getPostsFromEntryData(context, ig) {
        const { request } = context;
        const { entryData, pageData: { pageType } } = ig;
        switch (pageType) {
            case PAGE_TYPES.PLACE: {
                const data = entryData?.LocationsPage?.[0]?.native_location_data;
                return [
                    this.getPostsFromEndpoint(pageType, data?.ranked),
                    this.getPostsFromEndpoint(pageType, data?.recent),
                ];
            }
            case PAGE_TYPES.PROFILE:
                return [
                    this.getPostsFromGraphQL(pageType, entryData?.ProfilePage?.[0]?.graphql || context.request.userData?.jsonResponse?.data),
                ];
            case PAGE_TYPES.HASHTAG: {
                const data = entryData?.TagPage?.[0]?.data;
                return [
                    this.getPostsFromEndpoint(pageType, data?.top),
                    this.getPostsFromEndpoint(pageType, data?.recent),
                ];
            }
            default:
                request.noRetry = true;
                throw new Error('Not supported');
        }
    }

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    formatPlaceOutput(context, ig) {
        const { entryData, pageData: { pageType } } = ig;

        const base = entryData.LocationsPage[0].native_location_data;
        const data = base.location_info;

        return {
            id: `${data.pk}`,
            name: data.name,
            lat: data.lat,
            lng: data.lng,
            slug: data.slug,
            website: data.website,
            locationAddress: data.location_address,
            locationCity: data.location_city,
            locationId: data.location_id,
            locationRegion: data.location_region,
            locationZip: data.location_zip,
            phone: data.phone,
            category: data.category,
            profilePicUrl: data.profile_pic_url,
            topPosts: this.getPostsFromEndpoint(pageType, base.ranked).posts,
            latestPosts: this.getPostsFromEndpoint(pageType, base.recent).posts,
        };
    }

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    formatHashtagOutput(context, ig) {
        const { entryData, pageData: { pageType } } = ig;

        const { data } = entryData.TagPage[0];

        return {
            id: `${data.pk}`,
            name: data.name,
            public: data.has_public_page,
            topPostsOnly: data.is_top_media_only,
            profilePicUrl: data.profile_pic_url,
            postsCount: data.media_count,
            topPosts: this.getPostsFromEndpoint(pageType, data.top).posts.map((post) => this.formatPostForOutput(post)),
            latestPosts: this.getPostsFromEndpoint(pageType, data.recent).posts.map((post) => this.formatPostForOutput(post)),
        };
    }

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    async formatPostOutput(context, ig) {
        const likedBy = await this.getPostLikes(context, ig);
        const { additionalData } = ig;

        const data = additionalData.items?.[0];

        if (data) {
            return {
                ...this.formatPostForOutput(data),
                captionIsEdited: typeof data.caption_is_edited !== 'undefined' ? data.caption_is_edited : null,
                hasRankedComments: data.has_ranked_comments,
                commentsDisabled: data.comments_disabled,
                displayResourceUrls: this.getImages(data.carousel_media),
                childPosts: null,
                locationSlug: data?.location?.slug ?? null,
                isAdvertisement: typeof data.is_ad !== 'undefined' ? data.is_ad : null,
                taggedUsers: [],
                likedBy,
            };
        }

        return super.formatPostOutput(context, ig);
    }

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    async getOutputFromEntryData(context, ig) {
        const { pageType } = ig.pageData;

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
    async scrapePost(context, ig) {
        const { request } = context;
        const { additionalData, pageData } = ig;
        const { expandOwners } = this.options.input;

        const item = additionalData.items[0];

        let result = {
            // alt: item.accessibility_caption,
            // url: `https://www.instagram.com/p/${item.shortcode}`,
            // likesCount: item.edge_media_preview_like.count,
            // imageUrl: item.display_url,
            // firstComment: item.edge_media_to_caption.edges[0] && item.edge_media_to_caption.edges[0].node.text,
            // timestamp: new Date(parseInt(item.taken_at_timestamp, 10) * 1000).toISOString(),
            // locationName: item.location?.name ?? null,
            // ownerUsername: item.owner?.username ?? null,
        };

        if (expandOwners && pageData.pageType !== PAGE_TYPES.PROFILE) {
            [result] = await this.expandOwnerDetails(context, [result]);
        }

        return result;
    }

    /**
     * @param {Record<string, any>} [user]
     */
    formatEndpointUser(user) {
        return {
            ownerFullName: user?.full_name ? user.full_name : null,
            ownerUsername: user?.username ? user.username : null,
            ownerId: user?.pk ? `${user.pk}` : null,
            owner: {
                id: user?.pk ? `${user.pk}` : null,
                username: user?.username ?? null,
                fullName: user?.full_name ?? null,
                isPrivate: user?.is_private ?? null,
                profilePicUrl: user?.profile_pic_url ?? null,
            },
        };
    }

    /**
     * @param {Record<string, any>} item
     * @param {any[]} [latestComments]
     */
    formatPostForOutput(item, latestComments = []) {
        const medias = item.carousel_media ?? [];
        const caption = item.caption?.text?.trim?.() ?? null;
        const postInfo = helpers.parseCaption(caption);

        return {
            locationName: item.location?.name ?? null,
            locationId: item.location?.pk ? `${item.location.pk}` : null,
            locationLat: item.location?.lat ?? null,
            locationLng: item.location?.lat ?? null,
            type: item.media_type === 2 ? 'Video' : 'Image',
            shortCode: item.code,
            caption,
            ...postInfo,
            url: `https://www.instagram.com/p/${item.code}/`,
            commentsCount: item.comment_count || 0,
            latestComments,
            dimensionsHeight: item.original_height,
            dimensionsWidth: item.original_width,
            displayUrl: this.getDisplayUrl(medias),
            images: this.getImages(medias),
            videoUrl: item.video_url,
            id: `${item.pk}`,
            firstComment: latestComments?.[0]?.text ?? '',
            alt: null,
            likesCount: item.like_count ?? null,
            videoViewCount: item.video_view_count,
            timestamp: helpers.secondsToDate(item.caption?.created_at_utc),
            ...this.formatEndpointUser(item.user),
            productType: item.product_type,
            isSponsored: item.is_commercial,
            videoDuration: item.video_duration,
        };
    }

    /**
     * @param {any[]} medias
     */
    getDisplayUrl(medias = []) {
        return medias.find(({ image_versions2 }) => image_versions2?.candidates?.length)?.image_versions2?.candidates?.[0]?.url;
    }

    /**
     * @param {any[]} medias
     */
    getImages(medias = []) {
        return medias.flatMap(({ image_versions2 }) => image_versions2?.candidates?.map(({ url }) => url)).filter((s) => s);
    }

    /**
     * @param {any[]} posts
     * @param {any} pageData
     * @param {number} currentScrollingPosition
     */
    parseEndpointPostsForOutput(posts, pageData, currentScrollingPosition) {
        return posts.map((item, index) => {
            const latestComments = this.parseCommentsForOutput(item.preview_comments, pageData, currentScrollingPosition);

            return {
                queryTag: pageData.tagName,
                queryUsername: pageData.userUsername,
                queryLocation: pageData.locationName,
                position: currentScrollingPosition + 1 + index,
                ...this.formatPostForOutput(item, latestComments),
            };
        });
    }

    /**
     *
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    async scrapePosts(context, ig) {
        const { page, request } = context;
        const { extendOutputFunction, extendScraperFunction } = this.options;

        const cookieUser = request.userData?.jsonResponse?.data?.data?.user;

        let { pageData } = ig;

        const { pageType } = pageData;

        if (cookieUser) pageData = cookieUser;

        const state = this.initScrollingState(pageData.id);

        /**
         * @param {{ posts: any[], postsCount: number }} timeline
         * @param {(items: any[], position: number) => any[]} outputFn
         * @param {Puppeteer.HTTPResponse} [response]
         */
        const pushPosts = (timeline, outputFn, response) => {
            // todo: modify here
            // overwriting this for new response
            timeline = timeline?.posts ? timeline : pageData.edge_owner_to_timeline_media;
            return this.filterPushedItemsAndUpdateState(
                // timeline.posts,
                timeline?.posts?.length ? timeline.posts : timeline.edges,
                pageData.id,
                (items, position) => {
                    return outputFn(items, position);
                },
                async (item) => {
                    await extendOutputFunction(item, {
                        context,
                        response,
                        ig,
                        label: 'post',
                    });
                },
                {
                    label: this.logLabel(context, ig),
                    total: timeline.postsCount,
                },
            );
        };

        const checkedVariable = (() => {
            try {
                return helpers.getCheckedVariable(pageType);
            } catch (e) {
                request.noRetry = true;
                throw e;
            }
        })();

        log.debug('checkedVariable', { checkedVariable });
        const defer = helpers.deferred();
        const control = delay(300000);

        page.on('response', async (response) => {
            try {
                const responseUrl = response.url();
                const method = response.request().method();

                if (method === 'GET' && responseUrl.startsWith(GRAPHQL_ENDPOINT)) {
                    if (!this.isValidResponse(response)) {
                        return defer.reject(new Error('Login'));
                    }

                    // Skip queries for other stuff then posts
                    if (!responseUrl.includes(checkedVariable) || !responseUrl.includes('%22first%22')) {
                        log.debug('Skipping', { responseUrl, checkedVariable });
                        return;
                    }

                    // If it fails here, it means that the error was caught in the finite scroll anyway so we just don't do anything
                    const data = await (async () => {
                        try {
                            return await response.json();
                        } catch (e) {
                            log.debug(e.message);
                        }
                    })();

                    if (!data?.data) {
                        log.debug('no data');
                        return;
                    }

                    control.postpone();

                    const timeline = this.getPostsFromGraphQL(pageType, data.data);

                    if (state.hasNextPage && !timeline.hasNextPage) {
                        log.debug('no more posts from graphql');
                        state.hasNextPage = false;
                    }

                    return await pushPosts(
                        timeline,
                        (items, position) => this.parsePostsForOutput(items, pageData, position),
                        response,
                    );
                }

                if (method === 'POST' && responseUrl.includes(V1_ENDPOINT) && responseUrl.includes('/sections/')) {
                    const data = await (async () => {
                        try {
                            return await response.json();
                        } catch (e) {
                            log.debug(e.message);
                        }
                    })();

                    if (!data) {
                        return;
                    }

                    control.postpone();

                    const timeline = this.getPostsFromEndpoint(pageType, data);

                    if (state.hasNextPage && !timeline.hasNextPage) {
                        log.debug('no more posts from v1');
                        state.hasNextPage = false;
                    }

                    await pushPosts(
                        timeline,
                        (items, position) => this.parseEndpointPostsForOutput(items, pageData, position),
                        response,
                    );
                }
            } catch (e) {
                // throwing here would be the death of the run
                log.debug(`Error happened while processing response`, {
                    url: request.url,
                    error: e.message,
                });

                if (e.message === 'rateLimited') {
                    return defer.reject(errors.rateLimited());
                }

                if (e.message === 'Login') {
                    return defer.reject(errors.redirectedToLogin());
                }

                if (!e.message.includes('Network.')) {
                    return defer.reject(e);
                }
            } finally {
                await extendScraperFunction(undefined, {
                    context,
                    ig,
                    label: 'RESPONSE',
                    response,
                });
            }
        });

        const timelines = this.getPostsFromEntryData(context, ig);
        let hasNextPage = false;

        for (const timeline of timelines) {
            hasNextPage = hasNextPage || timeline.hasNextPage;

            await pushPosts(
                timeline,
                (items, position) => {
                    return pageType === PAGE_TYPES.PROFILE
                        ? this.parsePostsForOutput(items, pageData, position)
                        : this.parseEndpointPostsForOutput(items, pageData, position);
                },
            );
        }

        if (!hasNextPage) {
            state.hasNextPage = false;
            return;
        }

        try {
            // non moving scrollHeight usually means the tab is in the background and
            // the page interaction isn't working
            await control.run([
                defer.considerHandled(),
                (async () => {
                    while (state.hasNextPage && !defer.resolved) {
                        const ret = await this.finiteScroll(
                            context,
                            ig,
                            'posts',
                        );

                        if (!ret) {
                            break;
                        }
                    }
                })(),
            ]);
        } catch (e) {
            context.session.retire();
            throw e;
        } finally {
            try {
                page.removeAllListeners('response');
                control.abort();
            } catch (e) {}
        }
    }

    /**
     *
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    async scrapePostDetail(context, ig) {
        const { extendOutputFunction } = this.options;
        const { includeHasStories } = this.options.input;

        let hasPublicStories;

        if (includeHasStories) hasPublicStories = await this.loadPublicStories(context, ig);

        const output = await this.getOutputFromEntryData(context, ig);

        if (includeHasStories) output.hasPublicStory = hasPublicStories?.user?.has_public_story ?? false;

        await extendOutputFunction(output, {
            context,
            ig,
            label: 'details',
        });
    }

    /**
     * Hook for challenge page
     *
     * @param {consts.PuppeteerContext} context
     */
    challengePage(context) {
        const { session } = context;

        if (this.logins.hasSession(session)) {
            this.logins.increaseError(session);
        }

        return super.challengePage(context);
    }

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    async scrapeStories(context, ig) {
        const { page, request } = context;
        const { entryData } = ig;
        const { extendOutputFunction, input: { resultsLimit } } = this.options;

        const reelId = entryData?.ProfilePage?.[0]?.graphql?.user?.id
            ?? entryData?.StoriesPage?.[0]?.user?.id;

        if (!reelId) {
            log.warning(`No stories for ${request.url}`);
            return;
        }

        const response = await helpers.singleQuery(
            profileStories,
            {
                reel_ids: [reelId],
                tag_names: [],
                location_ids: [],
                highlight_reel_ids: [],
                precomposed_overlay: false,
                show_story_viewer_list: true,
                story_viewer_fetch_count: 50,
                story_viewer_cursor: '',
                stories_video_dash_manifest: false,
            },
            (d) => d,
            page,
            'Stories',
        );

        const timeline = (() => {
            if (!response) return;

            /** @type {any[]} */
            const stories = response?.reels_media?.[0]?.items ?? [];
            const storiesCount = stories.length;

            return { stories, storiesCount };
        })();

        if (timeline?.stories) {
            const storyId = request.url.match(/\/stories\/[^/]+\/(\d+)\//);
            const stories = timeline.stories.filter(({ id }) => (storyId?.[1] ? id === storyId?.[1] : true));

            log.info(`Scraped ${stories.length}/${timeline.storiesCount} stories from ${request.url}`);

            await extendOutputFunction(stories.slice(0, resultsLimit), {
                context,
                ig,
                label: 'stories',
            });
        } else {
            throw errors.storiesNotLoaded(reelId);
        }
    }

    /**
     * @param {keyof typeof PAGE_TYPES} pageType
     * @param {{ more_available: boolean, media_count: number, sections: any[], edge_owner_to_timeline_media: any }} data
     * @returns {{ hasNextPage: boolean, posts: any[], postsCount: number }}
     */
    getPostsFromEndpoint(pageType, data) {
        /** @param {any[]} [sections] */
        const filterSections = (sections = []) => {
            return sections.filter(({ layout_type }) => layout_type === 'media_grid')
                .flatMap(({ layout_content }) => layout_content.medias.map(({ media }) => media));
        };

        switch (pageType) {
            case PAGE_TYPES.PLACE: {
                const posts = filterSections(data?.sections);

                return {
                    hasNextPage: data?.more_available ?? false,
                    posts,
                    postsCount: posts.length,
                };
            }
            case PAGE_TYPES.PROFILE:
                return {
                    hasNextPage: data?.edge_owner_to_timeline_media?.page_info?.has_next_page ?? false,
                    posts: data?.edge_owner_to_timeline_media?.edges,
                    postsCount: data?.edge_owner_to_timeline_media?.count,
                };
            case PAGE_TYPES.HASHTAG: {
                const posts = filterSections(data?.sections);

                return {
                    hasNextPage: data?.more_available ?? false,
                    posts,
                    postsCount: data?.media_count ?? posts.length,
                };
            }
            default:
                throw new Error('Not supported');
        }
    }

    /**
     * @param {consts.IGData} ig
     * @param {Request} request
     */
    getPageData(ig, request) {
        const { entryData, additionalData } = ig;

        if (entryData.LocationsPage) {
            const itemData = entryData.LocationsPage[0].native_location_data.location_info;

            return {
                pageType: PAGE_TYPES.PLACE,
                id: itemData.location_id,
                lat: itemData.lat,
                lng: itemData.lng,
                locationId: itemData.id,
                locationName: itemData.name,
            };
        }

        if (entryData.TagPage) {
            const itemData = entryData.TagPage[0].data;

            return {
                pageType: PAGE_TYPES.HASHTAG,
                count: itemData.media_count,
                id: itemData.id,
                tagId: itemData.id,
                tagName: itemData.name,
            };
        }

        if (entryData.ProfilePage || request.userData.contentType === PAGE_TYPES.PROFILE) {
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
            const itemData = additionalData.items?.[0];

            if (itemData) {
                return {
                    pageType: PAGE_TYPES.POST,
                    id: itemData.code,
                    postCommentsDisabled: itemData.comments_disabled,
                    postIsVideo: itemData.is_video,
                    postVideoViewCount: itemData.video_view_count || 0,
                    postVideoDurationSecs: itemData.video_duration || 0,
                };
            }

            return super.getPageData(ig, request);
        }

        if (entryData.StoriesPage) {
            const itemData = entryData.StoriesPage?.[0]?.user;

            return {
                id: itemData?.id,
                userId: itemData?.id,
                userUsername: itemData?.username,
                pageType: PAGE_TYPES.STORY,
            };
        }

        return super.getPageData(ig, request);
    }

    async run() {
        this.logins = await loginManager({
            maxErrorCount: this.options.input.maxErrorCount,
            loginCookies: this.options.input.loginCookies,
        });

        if (!this.logins.loginCount()) {
            throw new Error('No session information found, aborting.');
        }

        this.autoscaledPoolOptions.maxConcurrency = this.logins.loginCount();

        await super.run();
    }
}

module.exports = LoginScraper;
