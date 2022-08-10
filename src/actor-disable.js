const { getPageTypeFromUrl } = require('./helpers');
const { PAGE_TYPES, SCRAPE_TYPES } = require('./consts');

module.exports.maybeDisableActor = (input) => {
    // We want to be able to run the actor even with some inputs not allowed for normal users 
    if (input.debugLog) {
        return;
    }

    const startUrl = input.directUrls?.[0];
    const pageType = getPageTypeFromUrl(startUrl);

    const isProfileToDetails = pageType === PAGE_TYPES.PROFILE && input.resultsType === SCRAPE_TYPES.DETAILS;
    const isPostToDetails = pageType === PAGE_TYPES.POST && input.resultsType === SCRAPE_TYPES.DETAILS;
    const isPostToComments = pageType === PAGE_TYPES.POST && input.resultsType === SCRAPE_TYPES.COMMENTS;
    const isPlacesPostsWithCookie = pageType === PAGE_TYPES.PLACE && input.resultsType === SCRAPE_TYPES.POSTS && input.loginCookies?.length;
    const isProfileToPosts = pageType === PAGE_TYPES.PROFILE && input.resultsType === SCRAPE_TYPES.POSTS;
    const isLogin = input.loginCookies?.length > 0;
    if (isProfileToDetails || isPostToDetails || (isProfileToPosts && isLogin) || isPostToComments || isPlacesPostsWithCookie) {
        // we can run this
        return;
    }

    throw `******\nINSTAGRAM SCRAPER DOESN'T WORK FOR SOME INPUTS!\nInstagram changed layout of their page and most input types stopped working\n`
    + `Currently working inputs:\n\nProfile details\nPost details\nProfile posts (only with login cookies)\nPlaces Posts (only with login cookies)\n Post comments\n\n`
    + `We decided to completely disable this scraper until this issue is resolved to prevent further spending of your credits\n`
    + `Some use-cases should be enabled today or tomorrow, most till the end of the week\n`
    + `We will notify you on email once this actor is enabled again\n`
    + `*****`;
};
