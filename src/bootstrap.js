const Apify = require('apify');

const { getPageTypeFromUrl } = require('./helpers');
const { PAGE_TYPES } = require('./consts');

const { log } = Apify.utils;

// metamorph to child actor for getting posts from direct profile URLs
// to disable build with env.BOOTSTRAP_OFF set
module.exports.bootstrapMetamorph = async (input) => {
    const {
        resultsType,
        directUrls,
        loginCookies,
        noMetamorph,
    } = input;

    const areUrlsProfile = directUrls?.length > 0
        && directUrls.every((url) => getPageTypeFromUrl(url) === PAGE_TYPES.PROFILE);

    if (areUrlsProfile && resultsType === 'posts' && !loginCookies?.length) {
        if (!Apify.isAtHome() || noMetamorph) {
            log.warning(`Will not metamorph to child actor for getting posts from direct profile URLs`);
            return;
        }
        // Separate instance for metamorph from instagram-scraper published as Deprecated to not expose it in Store
        await Apify.metamorph('alexey/mmorph-quick-instagram-profile-check', input);
    }
};
