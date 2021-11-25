// eslint-disable-next-line no-unused-vars
const Apify = require('apify');
const { PAGE_TYPES } = require('./consts');
/**
 * Add a post
 *
 * @param {Apify.RequestQueue} requestQueue
 */
const createAddPost = (requestQueue) => {
    /**
     * @param {string} code
     */
    return async (code) => {
        const url = new URL(code, 'https://www.instagram.com/p/');

        return requestQueue.addRequest({
            url: url.toString(),
            userData: {
                pageType: PAGE_TYPES.POST,
            },
        });
    };
};

module.exports = {
    createAddPost,
};
