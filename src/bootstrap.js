const Apify = require('apify');

const { log } = Apify.utils;

// metamorph to child actor for getting posts from direct profile URLs
// to disable build with env.BOOTSTRAP_OFF set
module.exports.bootstrapMetamorph = async (input) => {
    const {
        resultsType,
        directUrls
    } = input;

    if (!Apify.isAtHome()) {
        return;
    }

    if (directUrls?.length && resultsType === 'posts') {
        if (!process.env.BOOTSTRAP_OFF) {
            log.warning('[DISABLED] bootstrapMetamorph');
            return;
        }
        // Separate instance for metamorph from instagram-scraper published as Deprecated to not expose it in Store
        await Apify.metamorph('alexey/mmorph-quick-instagram-profile-check', input);    
    }
};
