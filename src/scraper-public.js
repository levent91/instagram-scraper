const Apify = require('apify');
const Puppeteer = require('puppeteer');
const delay = require('delayable-idle-abort-promise').default;

const consts = require('./consts');

const { PAGE_TYPES, GRAPHQL_ENDPOINT } = consts;
const BaseScraper = require('./scraper-base');

const { formatDisplayResources, formatSinglePost, formatIGTVVideo } = require('./details');
const errors = require('./errors');
const helpers = require('./helpers');

const { log } = Apify.utils;

class PublicScraper extends BaseScraper {
    /**
     * @param {consts.IGData} ig
     */
    getItemSpec(ig) {
        const { entryData } = ig;

        if (entryData.LocationsPage) {
            const itemData = entryData.LocationsPage[0].graphql.location;

            return {
                pageType: PAGE_TYPES.PLACE,
                id: itemData.id,
                address: itemData?.address_json ? JSON.parse(itemData.address_json) : {},
                lat: itemData.lat,
                lng: itemData.lng,
                locationId: itemData.id,
                locationSlug: itemData.slug,
                locationName: itemData.name,
            };
        }

        if (entryData.TagPage) {
            const itemData = entryData.TagPage[0].graphql.hashtag;

            return {
                pageType: PAGE_TYPES.HASHTAG,
                id: itemData.id,
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

        return super.getItemSpec(ig);
    }

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    async scrapeComments(context, ig) {
        const { extendOutputFunction } = this.options;
        const { page } = context;
        const { entryData, itemSpec } = ig;

        const timeline = this.getCommentsFromGraphQL(entryData.PostPage[0].graphql);
        const state = this.initScrollingState(itemSpec.id);

        // Public comments are preloaded on page load and can't be iterated
        await this.filterPushedItemsAndUpdateState(
            timeline.comments,
            itemSpec.id,
            (comments, position) => {
                const result = this.parseCommentsForOutput(comments, itemSpec, position);

                log.info(`${itemSpec.label} ${comments.length} comments loaded, ${Object.keys(state.ids).length}/${timeline.commentsCount} comments scraped`);

                return result;
            },
            async (comment) => {
                await extendOutputFunction(comment, {
                    ...context,
                    ig,
                    label: 'comment',
                    page,
                });
            },
        );
    }

    /**
     *
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    async scrapePostDetail(context, ig) {
        await super.scrapePostDetail(context, ig);

        const { extendOutputFunction } = this.options;

        await extendOutputFunction(await this.scrapePost(context, ig), {
            ...context,
            ig,
            label: 'post',
        });
    }

    /**
     *
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    async scrapePosts(context, ig) {
        const { extendScraperFunction, extendOutputFunction } = this.options;
        const { page, request } = context;
        const { itemSpec } = ig;
        const { pageType } = itemSpec;

        const state = this.initScrollingState(itemSpec.id);

        // Get variable we look for in the query string of request
        const checkedVariable = helpers.getCheckedVariable(pageType);

        // safety net for endless scrolling and no data being returned
        const control = delay(300000);
        const defer = helpers.deferred();

        /**
         * @param {{ posts: any[], postsCount: number }} timeline
         * @param {Puppeteer.HTTPResponse} [response]
         */
        const pushPosts = (timeline, response = undefined) => {
            return this.filterPushedItemsAndUpdateState(
                timeline.posts,
                itemSpec.id,
                (items, position) => {
                    log.info(`${itemSpec.label} ${items.length} posts loaded, ${Object.keys(state.ids).length}/${timeline.postsCount} posts scraped`);

                    return this.parsePostsForOutput(items, itemSpec, position);
                },
                async (item) => {
                    await extendOutputFunction(item, {
                        ...context,
                        response,
                        ig,
                        label: 'post',
                    });
                },
            );
        };

        page.on('response', async (response) => {
            try {
                const responseUrl = response.url();

                if (response.request().method() === 'GET' && responseUrl.startsWith(GRAPHQL_ENDPOINT)) {
                    if (!this.isValidResponse(response)) {
                        return defer.reject(new Error('Login'));
                    }

                    // Skip queries for other stuff then posts
                    if (!responseUrl.includes(checkedVariable) && !responseUrl.includes('%22first%22')) {
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

                    const timeline = this.getPostsFromGraphQL(pageType, data.data);

                    if (state.hasNextPage && !timeline.hasNextPage) {
                        state.hasNextPage = false;
                    }

                    await pushPosts(timeline);
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
                    defer.reject(e);
                }
            } finally {
                await extendScraperFunction(undefined, {
                    ...context,
                    ig,
                    label: 'RESPONSE',
                    response,
                });
            }
        });

        const timeline = this.getPostsFromEntryData(context, ig);

        if (!timeline) {
            return;
        }

        // Check if the posts loaded properly
        if (pageType === PAGE_TYPES.PROFILE) {
            const profilePageSel = '.ySN3v';

            try {
                await page.waitForSelector(`${profilePageSel}`, { timeout: 5000 });
            } catch (e) {
                log.error('Profile page didn\'t load properly, trying again...');
                throw new Error('Profile page didn\'t load properly, trying again...');
            }

            const privatePageSel = '.rkEop';
            const elPrivate = await page.$(`${privatePageSel}`);
            if (elPrivate) {
                log.error('Profile is private exiting..');
                return;
            }
        }

        if (pageType === PAGE_TYPES.PLACE || pageType === PAGE_TYPES.HASHTAG) {
            if ((await page.$$('.YlEaT')).length > 0) {
                request.noRetry = true;
                throw new Error('No posts on page');
            }

            try {
                await page.waitForSelector('.EZdmt', { timeout: 25000 });
            } catch (e) {
                log.error('Place/location or hashtag page didn\'t load properly, trying again...');
                throw new Error('Place/location or hashtag page didn\'t load properly, trying again...');
            }
        }

        await pushPosts(timeline);

        try {
            // Places/locations don't allow scrolling without login
            if (pageType === PAGE_TYPES.PLACE) {
                log.warning('Place/location pages allow scrolling only under login, collecting initial posts and finishing');
                return;
            }

            control.postpone();

            await control.run([
                defer.promise,
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
            } catch (e) {}
        }
    }

    /**
     * Takes type of page and it's initial loaded data and outputs
     * correct list of posts based on the page type.
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    getPostsFromEntryData(context, ig) {
        const { request } = context;
        const { entryData, itemSpec: { pageType } } = ig;

        let pageData;
        switch (pageType) {
            case PAGE_TYPES.PLACE:
                pageData = entryData?.LocationsPage?.[0]?.graphql;
                break;
            case PAGE_TYPES.PROFILE:
                pageData = entryData?.ProfilePage?.[0]?.graphql;
                break;
            case PAGE_TYPES.HASHTAG:
                pageData = entryData?.TagPage?.[0]?.graphql;
                break;
            default:
                request.noRetry = true;
                throw new Error('Not supported');
        }

        if (!pageData) return null;

        return this.getPostsFromGraphQL(pageType, pageData);
    }

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    formatPlaceOutput(context, ig) {
        const { entryData } = ig;

        const data = entryData.LocationsPage[0].graphql.location;

        return {
            id: data.id,
            name: data.name,
            public: data.has_public_page,
            lat: data.lat,
            lng: data.lng,
            slug: data.slug,
            description: data.blurb,
            website: data.website,
            phone: data.phone,
            aliasOnFacebook: data.primary_alias_on_fb,
            ...helpers.formatJSONAddress(data.address_json),
            profilePicUrl: data.profile_pic_url,
            postsCount: data.edge_location_to_media.count,
            topPosts: data.edge_location_to_top_posts ? data.edge_location_to_top_posts.edges.map((edge) => edge.node).map(formatSinglePost) : [],
            latestPosts: data.edge_location_to_media ? data.edge_location_to_media.edges.map((edge) => edge.node).map(formatSinglePost) : [],
        };
    }

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    formatHashtagOutput(context, ig) {
        const { entryData } = ig;

        const data = entryData.TagPage[0].graphql.hashtag;

        return {
            id: data.id,
            name: data.name,
            public: data.has_public_page,
            topPostsOnly: data.is_top_media_only,
            profilePicUrl: data.profile_pic_url,
            postsCount: data.edge_hashtag_to_media.count,
            topPosts: data.edge_hashtag_to_top_posts ? data.edge_hashtag_to_top_posts.edges.map((edge) => edge.node).map(formatSinglePost) : [],
            latestPosts: data.edge_hashtag_to_media ? data.edge_hashtag_to_media.edges.map((edge) => edge.node).map(formatSinglePost) : [],
        };
    }

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    async formatPostOutput(context, ig) {
        const likedBy = await this.getPostLikes(context, ig);
        const { entryData } = ig;

        const data = entryData.PostPage[0].graphql.shortcode_media;

        return {
            ...formatSinglePost(data),
            captionIsEdited: typeof data.caption_is_edited !== 'undefined' ? data.caption_is_edited : null,
            hasRankedComments: data.has_ranked_comments,
            commentsDisabled: data.comments_disabled,
            displayResourceUrls: data.edge_sidecar_to_children ? formatDisplayResources(data.edge_sidecar_to_children.edges) : null,
            childPosts: data.edge_sidecar_to_children ? data.edge_sidecar_to_children.edges.map((child) => formatSinglePost(child.node)) : null,
            locationSlug: data.location ? data.location.slug : null,
            isAdvertisement: typeof data.is_ad !== 'undefined' ? data.is_ad : null,
            taggedUsers: data.edge_media_to_tagged_user ? data.edge_media_to_tagged_user.edges.map((edge) => edge.node.user.username) : [],
            likedBy,
        };
    }

    /**
     * @param {consts.PuppeteerContext} context
     * @param {consts.IGData} ig
     */
    async scrapePost(context, ig) {
        const { entryData, itemSpec } = ig;
        const { expandOwners } = this.options.input;

        const item = entryData.PostPage[0].graphql.shortcode_media;

        let result = {
            alt: item.accessibility_caption,
            url: `https://www.instagram.com/p/${item.shortcode}`,
            likesCount: item.edge_media_preview_like.count,
            imageUrl: item.display_url,
            firstComment: item.edge_media_to_caption?.edges?.[0]?.node?.text || '',
            timestamp: new Date(parseInt(item.taken_at_timestamp, 10) * 1000).toISOString(),
            locationName: item.location?.name ?? null,
            ownerUsername: item.owner?.username ?? null,
        };

        if (expandOwners && itemSpec.pageType !== PAGE_TYPES.PROFILE) {
            [result] = await this.expandOwnerDetails(context, [result]);
        }

        return this.setDebugData(context, ig, result);
    }

    /**
     * Hook for challenge page
     *
     * @param {consts.PuppeteerContext} context
     */
    challengePage(context) {
        const { session } = context;

        session.retire();

        return super.challengePage();
    }
}

module.exports = PublicScraper;
