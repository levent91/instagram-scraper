const Apify = require('apify');
const Puppeteer = require('puppeteer'); // eslint-disable-line no-unused-vars
const { query } = require('./helpers');

const { storiesNotLoaded } = require('./errors');

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
    if (!data.entry_data.StoriesPage) {
        Apify.utils.log.warning(`No stories for ${request.url}`);
        return;
    }
    const { itemSpec } = page;
    const reelId = data.entry_data.StoriesPage[0].user.id;

    const response = await query(
        `https://i.instagram.com/api/v1/feed/reels_media/?reel_ids=${reelId}`,
        page,
        (d) => d,
        itemSpec,
        'Stories',
        false,
    );

    const timeline = getStoriesFromGraphQL(response);

    if (timeline) {
        Apify.utils.log.info(`Scraped ${timeline.storiesCount} stories`);
        await extendOutputFunction(timeline.stories, {
            label: 'stories',
        });
    } else {
        throw storiesNotLoaded(reelId);
    }
};

module.exports = {
    scrapeStories,
};
