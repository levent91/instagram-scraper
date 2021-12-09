// eslint-disable-next-line no-unused-vars
const Apify = require('apify');

/**
 * @typedef {Parameters<Apify.PuppeteerHandlePage>[0]} PuppeteerContext
 */

/**
 * @typedef {{ entryData: Record<string, any>, additionalData: Record<string, any>, pageData: Record<string, any> }} IGData
 */

/**
 * @typedef {{
 *   requestList: Apify.RequestList,
 *   requestQueue: Apify.RequestQueue,
 *   proxyConfiguration?: Apify.ProxyConfiguration,
 *   input: {
 *     resultsType: string,
 *     resultsLimit: number,
 *     maxRequestRetries: number,
 *     loginCookies: Array<Record<string, any> | Array<Record<string, any>>>,
 *     directUrls: string[],
 *     maxErrorCount: number,
 *     debugLog: boolean,
 *     includeHasStories: boolean,
 *     cookiesPerConcurrency: number,
 *     includeTaggedPosts: boolean,
 *     likedByLimit: number,
 *     followingLimit: number,
 *     followedByLimit: number,
 *     expandOwners: boolean
 *   },
 *   scrollingState: {
 *      [index: string]: {
 *         hasNextPage: boolean,
 *         ids: { [id: string]: boolean },
 *         reachedLastPostDate: boolean,
 *         allDuplicates: boolean
 *      }
 *   },
 *   extendOutputFunction: (data: any, meta: any) => Promise<void>,
 *   extendScraperFunction: (data: any, meta: any) => Promise<void>,
 *   minMaxDate: import('./helpers').MinMaxDates
 * }} Options
 */

module.exports = {
    // Types of Apify.utils.log
    LOG_TYPES: {
        DEBUG: 'debug',
        INFO: 'info',
        WARNING: 'warning',
        ERROR: 'error',
        EXCEPTION: 'exception',
    },
    // Types of pages which this actor is able to process
    PAGE_TYPES: {
        PLACE: 'location',
        PROFILE: 'user',
        HASHTAG: 'hashtag',
        POST: 'post',
        STORY: 'story',
        CHALLENGE: 'challenge',
        AGE: 'age',
        DONTEXIST: 'dont',
    },
    // Types of scrapes this actor can do
    SCRAPE_TYPES: {
        POSTS: 'posts',
        COMMENTS: 'comments',
        DETAILS: 'details',
        STORIES: 'stories',
        POST_DETAIL: 'detail',
    },
    // Types of search queries available in instagram search
    SEARCH_TYPES: {
        PLACE: 'place',
        USER: 'user',
        HASHTAG: 'hashtag',
    },
    PAGE_TYPE_URL_REGEXES: {
        PLACE: /https:\/\/(www\.)?instagram\.com\/explore\/locations\/.+/u,
        PROFILE: /https:\/\/(www\.)?instagram\.com\/[^/]{2,}\/?$/u,
        HASHTAG: /https:\/\/(www\.)?instagram\.com\/explore\/tags\/.+/u,
        POST: /https:\/\/(www\.)?instagram\.com\/(p|reel)\/.+/u,
        STORY: /https:\/\/(www\.)?instagram\.com\/stories\/.+/u,
    },
    // Instagrams GraphQL Endpoint URL
    GRAPHQL_ENDPOINT: 'https://www.instagram.com/graphql/query/',
    V1_ENDPOINT: 'https://i.instagram.com/api/v1',
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
        '/fxcal',
        'oauth/status',
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
        'es6/ActivityFeedBox',
    ],
    QUERY_IDS: {
        postCommentsQueryId: '97b41c52301f77ce508f55e66d17620e',
        postLikesQueryId: 'd5d763b1e2acf209d62d22d184488e57',
        placePostsQueryId: '1b84447a4d8b6d6d0426fefb34514485',
        hashtagPostsQueryId: '174a5243287c5f3a7de741089750ab3b',
        profilePostsQueryId: '58b6785bea111c67129decbe6a448951',
        profileFollowingQueryId: 'd04b0a864b4b54837c0d870b0e77e076',
        profileFollowersQueryId: 'c76146de99bb02f6415203be841dd25a',
        profileChannelQueryId: 'bc78b344a68ed16dd5d7f264681c4c76',
        profileTaggedQueryId: 'ff260833edf142911047af6024eb634a',
        postQueryId: 'fead941d698dc1160a298ba7bec277ac',
        postShortCodeMedia: '2efa04f61586458cef44441f474eee7c',
        profileHighlights: '45246d3fe16ccc6577e0bd297a5db1ab',
        profilePublicStories: 'd4d88dc1500312af6f937f7b804c68c3',
        taggedPostsQueryId: 'be13233562af2d229b008d2976b998b5',
        profileStories: 'c9c56db64beb4c9dea2d17740d0259d9',
    },
};
