const { getPageTypeFromUrl } = require('./helpers');
const { PAGE_TYPES } = require('./consts');

module.exports.maybeDisableActor = (input) => {
    const startUrl = input.directUrls?.[0];
    const pageType = getPageTypeFromUrl(startUrl);
    console.log(`Page type: ${pageType}`);

    if (pageType === PAGE_TYPES.PROFILE && input.resultsType === 'details') {
        return;
    }

    throw `******\nINSTAGRAM SCRAPER DOESN'T WORK FOR SOME INPUTS!\nInstagram changed layout of their page and most input types stopped working\n`
    + `Currently working inputs:\nProfile details\n\n`
    + `We decided to completely disable this scraper until this issue is resolved to prevent further spending of your credits\n`
    + `Some use-cases should be enabled today or tomorrow, most till the end of the week\n`
    + `We will notify you on email once this actor is enabled again\n`
    + `*****`;

}