const Apify = require('apify');
const { SEARCH_TYPES, PAGE_TYPES } = require('./consts');
const errors = require('./errors');

// Helper functions that create direct links to search results
const formatPlaceResult = item => `https://www.instagram.com/explore/locations/${item.place.location.pk}/${item.place.slug}/`;
const formatUserResult = item => `https://www.instagram.com/${item.user.username}/`;
const formatHashtagResult = item => `https://www.instagram.com/explore/tags/${item.hashtag.name}/`;

/**
 * Attempts to query Instagram search and parse found results into direct links to instagram pages
 * @param {any} input Input loaded from Apify.getInput();
 * @param {Apify.ProxyConfiguration} [proxyConfig]
 */
const searchUrls = async (input, proxyConfig, retries = 0) => {
    const { search, searchType, searchLimit = 10 } = input;
    if (!search) return [];

    try {
        if (!searchType) throw errors.searchTypeIsRequired();
        if (!Object.values(SEARCH_TYPES).includes(searchType)) throw errors.unsupportedSearchType(searchType);
    } catch (error) {
        Apify.utils.log.info('--  --  --  --  --');
        Apify.utils.log.info(' ');
        Apify.utils.log.error('Run failed because the provided input is incorrect:');
        Apify.utils.log.error(error.message);
        Apify.utils.log.info(' ');
        Apify.utils.log.info('--  --  --  --  --');
        process.exit(1);
    }

    Apify.utils.log.info(`Searching for "${search}"`);

    const searchUrl = `https://www.instagram.com/web/search/topsearch/?context=${searchType}&query=${encodeURIComponent(search)}`;
    const { body } = await (async () => {
        try {
            return await Apify.utils.requestAsBrowser({
                url: searchUrl,
                abortFunction: () => false,
                proxyUrl: proxyConfig?.newUrl(`session${Math.round(Math.random() * 100000)}`),
                json: true,
            });
        } catch (e) {
            Apify.utils.log.debug('Search', { searchUrl, message: e.message });

            return {
                body: null,
            };
        }
    })();

    Apify.utils.log.debug('Response', { body });

    if (!body) {
        if (retries < 10) {
            Apify.utils.log.warning(`Server returned non-json answer, retrying ${10 - retries - 1} times`);
            return searchUrls(input, proxyConfig, retries + 1);
        }

        throw new Error('Search is blocked on current proxy IP');
    }

    /** @type {string[]} */
    let urls = [];
    if (searchType === SEARCH_TYPES.USER) urls = body.users.map(formatUserResult);
    else if (searchType === SEARCH_TYPES.PLACE) urls = body.places.map(formatPlaceResult);
    else if (searchType === SEARCH_TYPES.HASHTAG) urls = body.hashtags.map(formatHashtagResult);

    Apify.utils.log.info(`Found ${urls.length} search results. Limiting to ${searchLimit}.`);
    urls = urls.slice(0, searchLimit);

    return urls;
};

module.exports = {
    searchUrls,
};
