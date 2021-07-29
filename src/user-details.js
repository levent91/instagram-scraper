// eslint-disable-next-line no-unused-vars
const Puppeteer = require('puppeteer');
const Apify = require('apify');
const { QUERY_IDS } = require('./query_ids');

const { sleep } = Apify.utils;

const { postQueryId } = QUERY_IDS;

const users = {};

/**
 * @param {any[]} posts
 * @param {Puppeteer.Page} page
 * @param {any} itemSpec
 */
async function expandOwnerDetails(posts, page, itemSpec) {
    // We have to require it here because of circular dependency
    const { log, singleQuery } = require('./helpers');
    log(itemSpec, `Owner details - Expanding details for ${posts.length} items.`);
    const defaultVariables = { child_comment_count: 3, fetch_comment_count: 40, parent_comment_count: 24, has_threaded_comments: true };
    const transformFunction = (data) => {
        return data.shortcode_media.owner;
    };
    const transformedPosts = [];
    for (let i = 0; i < posts.length; i++) {
        log(itemSpec, `Owner details - Expanding owner details of post ${i + 1}/${posts.length}`);
        if (!posts[i].ownerId) {
            transformedPosts.push(posts[i]);
            // eslint-disable-next-line no-continue
            continue;
        }
        const newPost = { ...posts[i] };
        if (users[posts[i].ownerId]) {
            newPost.ownerUsername = users[posts[i].ownerId].username;
            newPost.owner = users[posts[i].ownerId];
            transformedPosts.push(newPost);
            // eslint-disable-next-line no-continue
            continue;
        }
        try {
            const owner = await singleQuery(
                postQueryId,
                { shortcode: posts[i]['#debug'].shortcode, ...defaultVariables },
                transformFunction,
                page,
                itemSpec,
                'Owner details',
            );
            users[posts[i].ownerId] = owner;
            newPost.ownerUsername = users[posts[i].ownerId].username;
            newPost.owner = users[posts[i].ownerId];
        } catch (e) {
            Apify.utils.log.debug(`${e.message}`, posts[i]);
        }
        transformedPosts.push(newPost);
        await sleep(500);
    }
    log(itemSpec, `Owner details - Details for ${posts.length} items expanded.`);
    return transformedPosts;
}

module.exports = {
    expandOwnerDetails,
};
