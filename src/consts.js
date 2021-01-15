module.exports = {
    // Types of Apify.utils.log
    LOG_TYPES: {
        DEBUG: 'debug',
        INFO: 'info',
        WARNING: 'warning',
        ERROR: 'error',
        EXCEPTION: 'exception'
    },
    // Types of pages which this actor is able to process
    PAGE_TYPES: {
        PLACE: 'location',
        PROFILE: 'user',
        HASHTAG: 'hashtag',
        POST: 'post',
        STORY: 'story',
    },
    // Types of scrapes this actor can do
    SCRAPE_TYPES: {
        POSTS: 'posts',
        COMMENTS: 'comments',
        DETAILS: 'details',
        STORIES: 'stories',
        COOKIES: 'cookies',
    },
    // Types of search queries available in instagram search
    SEARCH_TYPES: {
        PLACE: 'place',
        USER: 'user',
        HASHTAG: 'hashtag',
    },
    PAGE_TYPE_URL_REGEXES: {
        PLACE: /https:\/\/www\.instagram\.com\/explore\/locations\/.+/u,
        PROFILE: /https:\/\/www\.instagram\.com\/[^/]{2,}\/?$/u,
        HASHTAG: /https:\/\/www\.instagram\.com\/explore\/tags\/.+/u,
        POST: /https:\/\/www\.instagram\.com\/p\/.+/u,
        STORY: /https:\/\/www\.instagram\.com\/stories\/.+/u,
    },
    // Instagrams GraphQL Endpoint URL
    GRAPHQL_ENDPOINT: 'https://www.instagram.com/graphql/query/?query_hash=',
    // Resource types blocked from loading to speed up the solution
    ABORT_RESOURCE_TYPES: [
        'image',
        'media',
        'font',
        'texttrack',
        'fetch',
        'eventsource',
        'websocket',
        'other',
        // Manifest and stylesheets have to be present!!!
    ],
    ABORT_RESOURCE_URL_INCLUDES: [
        '/map_tile.php',
        '/logging_client_events',
        '/falco',
        '/bz',
    ],
    // These are needed for scrolling to work
    // TODO: Retest this
    ABORT_RESOURCE_URL_DOWNLOAD_JS: [
        'es6/Consumer',
        'es6/ProfilePageContainer',
        'es6/PostPageContainer',
        'es6/PostPageComments',
        'es6/PostComment',
        'es6/en',
        'es6/Vendor',
        'es6/ActivityFeedBox'
    ],
    HEADERS: {
        "access-control-expose-headers": 'X-IG-Set-WWW-Claim',
        accept: '*/*',
        'accept-encoding': 'gzip, deflate, br',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'x-ig-app-id': '936619743392459',
        'x-ig-www-claim': 'hmac.AR1-yiYTI0KAovABgcl_mYe5lSWZC3Jtjc8gMfXTp8Z2t6gQ',
        'x-requested-with': 'XMLHttpRequest',
    }
};
