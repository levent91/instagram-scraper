const Apify = require('apify');
const Puppeteer = require('puppeteer'); // eslint-disable-line no-unused-vars
const { singleQuery } = require('./helpers');

const { storiesNotLoaded } = require('./errors');
const { QUERY_IDS } = require('./query_ids');

/**
 * Takes type of page and data loaded through GraphQL and outputs
 * list of stories.
 * @param {Record<string, any>} data GraphQL data
 */
const getStoriesFromGraphQL = (data) => {
    if (!data) return;

    const stories = data?.reels_media?.[0]?.items ?? [];
    const storiesCount = stories.length;

    return { stories, storiesCount };
};

/**
 * Make XHR request to get stories data and store them to dataset
 * @param {{
 *   request: Apify.Request,
 *   page: Puppeteer.Page,
 *   data: any,
 *   extendOutputFunction: (data: any, meta: any) => Promise<void>,
 * }} params
 * @returns {Promise<void>}
 */
const scrapeStories = async ({ request, page, data, extendOutputFunction }) => {
    const { itemSpec } = page;
    const reelId = data?.entry_data?.ProfilePage?.[0]?.graphql?.user?.id
        ?? data?.entry_data?.StoriesPage?.[0]?.user?.id;

    if (!reelId) {
        Apify.utils.log.warning(`No stories for ${request.url}`);
        return;
    }

    const response = await singleQuery(
        QUERY_IDS.profileStories,
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
        itemSpec,
        'Stories',
    );

    const timeline = getStoriesFromGraphQL(response);

    if (timeline?.stories) {
        const storyId = request.url.match(/\/stories\/[^/]+\/(\d+)\//);
        const stories = timeline.stories.filter(({ id }) => (storyId?.[1] ? id === storyId?.[1] : true));

        Apify.utils.log.info(`Scraped ${stories.length}/${timeline.storiesCount} stories from ${request.url}`);

        await extendOutputFunction(stories, {
            label: 'stories',
        });
    } else {
        throw storiesNotLoaded(reelId);
    }
};

module.exports = {
    scrapeStories,
};
