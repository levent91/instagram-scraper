const Apify = require('apify');
const Puppeteer = require('puppeteer'); // eslint-disable-line no-unused-vars

const { storiesNotLoaded } = require('./errors');
const { loadXHR } = require('./helpers');

/**
 * Takes type of page and data loaded through GraphQL and outputs
 * list of stories.
 * @param {Object} data GraphQL data
 */
const getStoriesFromGraphQL = (data) => {
    if (!data) return;
    const { reels_media } = data;
    const itemsExists = reels_media && reels_media[0] && reels_media[0] && reels_media[0].items;

    const storyItems = itemsExists ? reels_media[0].items : [];
    const storiesCount = itemsExists ? storyItems.length : null;

    return { stories: storyItems, storiesCount };
};

/**
 * Takes GraphQL response, checks that it's a response with more stories and then parses the stories from it
 * @param {Object} response Puppeteer Response object
 */
async function handleStoriesGraphQLResponse(response) {
    const responseUrl = response.url;
    // Check queries for other stuff then stories
    if (!responseUrl.includes('%22reel_ids%22')) return;

    const data = await JSON.parse(response.body);
    const timeline = getStoriesFromGraphQL(data.data);

    Apify.utils.log.info(`Scraped ${timeline.storiesCount} stories`);
    await Apify.pushData(timeline.stories);
}

/**
 * Make XHR request to get stories data and store them to dataset
 * @param {{
 *   request: Apify.Request,
 *   page: Puppeteer.Page,
 *   data: any,
 *   proxyUrl: string
 * }} params
 * @returns {Promise<void>}
 */
const scrapeStories = async ({ request, page, data, proxyUrl }) => {
    if (!data.entry_data.StoriesPage) {
        Apify.utils.log.warning(`No stories for ${request.url}`);
        return;
    }
    const reelId = data.entry_data.StoriesPage[0].user.id;
    const url = `https://www.instagram.com/graphql/query/?query_hash=c9c56db64beb4c9dea2d17740d0259d9&variables=%7B%22reel_ids%22%3A%5B%22${reelId}%22%5D%2C%22tag_names%22%3A%5B%5D%2C%22location_ids%22%3A%5B%5D%2C%22highlight_reel_ids%22%3A%5B%5D%2C%22precomposed_overlay%22%3Afalse%2C%22show_story_viewer_list%22%3Atrue%2C%22story_viewer_fetch_count%22%3A50%2C%22story_viewer_cursor%22%3A%22%22%2C%22stories_video_dash_manifest%22%3Afalse%7D`;
    const { csrf_token } = data.config;

    const response = await loadXHR({ request, page, url, csrf_token, proxyUrl });

    if (response.statusCode === 200) {
        await handleStoriesGraphQLResponse(response);
    } else {
        throw storiesNotLoaded(reelId);
    }
};

module.exports = {
    scrapeStories,
};
