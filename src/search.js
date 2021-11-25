const Apify = require('apify');
const { SEARCH_TYPES, PAGE_TYPES } = require('./consts');
const errors = require('./errors');

const { log, sleep } = Apify.utils;

// Helper functions that create direct links to search results
/**
 * @param {Record<string, any>} item
 */
const formatPlaceResult = (item) => {
    return `https://www.instagram.com/explore/locations/${item.place.location.pk}/${item.place.slug}/`;
};
/**
 * @param {Record<string, any>} item
 */
const formatUserResult = (item) => {
    return `https://www.instagram.com/${item.user.username}/`;
};
/**
 * @param {Record<string, any>} item
 */
const formatHashtagResult = (item) => {
    return `https://www.instagram.com/explore/tags/${item.hashtag.name}/`;
};

/**
 * Attempts to query Instagram search and parse found results into direct links to instagram pages
 * @param {any} input Input loaded from Apify.getInput();
 * @param {(params: { url: string }) => Promise<any>} request
 */
const searchUrls = async (input, request) => {
    const { search, searchType, searchLimit = 10 } = input;
    if (!search) return [];

    try {
        if (!searchType) throw errors.searchTypeIsRequired();
        if (!Object.values(SEARCH_TYPES).includes(searchType)) throw errors.unsupportedSearchType(searchType);
    } catch (error) {
        log.info('--  --  --  --  --');
        log.info(' ');
        log.exception(error.message, 'Run failed because the provided input is incorrect:');
        log.info(' ');
        log.info('--  --  --  --  --');
        throw new Error('Run aborted');
    }

    /** @type {string[]} */
    const totalUrls = [];

    const searchTerms = new Set(search.split(',').map((s) => s.trim()).filter(Boolean));

    for (const searchTerm of searchTerms) {
        log.info(`Searching for "${searchTerm}"`);

        const searchUrl = `https://www.instagram.com/web/search/topsearch/?context=${searchType}&query=${encodeURIComponent(searchTerm)}`;
        const { body } = await (async () => {
            const doSearch = async (retries = 0) => {
                try {
                    return await request({
                        url: searchUrl,
                    });
                } catch (e) {
                    log.debug('Search', { searchUrl, message: e.message });

                    if (retries < 10) {
                        log.warning(`Server returned non-json answer, retrying ${10 - retries - 1} times`);
                        await sleep(500 * (retries + 1));
                        return doSearch(retries + 1);
                    }

                    return {
                        body: null,
                    };
                }
            };

            return doSearch();
        })();

        log.debug('Response', { body });

        if (!body) {
            throw new Error('Search is blocked on current proxy IP');
        }

        /** @type {string[]} */
        let urls = [];
        if (searchType === SEARCH_TYPES.USER) urls = body.users.map(formatUserResult);
        else if (searchType === SEARCH_TYPES.PLACE) urls = body.places.map(formatPlaceResult);
        else if (searchType === SEARCH_TYPES.HASHTAG) urls = body.hashtags.map(formatHashtagResult);

        log.info(`Found ${urls.length} search results for "${searchTerm}". Limiting to ${searchLimit}.`);
        totalUrls.push(...urls.slice(0, searchLimit));
    }

    return totalUrls;
};

/**
 * Add a location search by ID
 *
 * @param {Apify.RequestQueue} requestQueue
 */
const createLocationSearch = (requestQueue) => {
    /**
     * @param {string} locationId
     */
    return async (locationId) => {
        if (+locationId != locationId) {
            log.warning(`Location id ${locationId} isn't a valid number`);
            return;
        }

        const url = new URL(locationId, 'https://www.instagram.com/explore/locations/');

        return requestQueue.addRequest({
            url: url.toString(),
            userData: {
                pageType: PAGE_TYPES.PLACE,
            },
        });
    };
};

/**
 * Add a hashtag search
 *
 * @param {Apify.RequestQueue} requestQueue
 */
const createHashtagSearch = (requestQueue) => {
    /**
     * @param {string} hashtag
     */
    return async (hashtag) => {
        const url = new URL(`${hashtag}`.replace(/#/g, ''), 'https://www.instagram.com/explore/tags/');

        return requestQueue.addRequest({
            url: url.toString(),
            userData: {
                pageType: PAGE_TYPES.HASHTAG,
            },
        });
    };
};

module.exports = {
    searchUrls,
    createLocationSearch,
    createHashtagSearch,
};
