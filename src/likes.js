// eslint-disable-next-line no-unused-vars
const Puppeteer = require('puppeteer');
const { log, finiteQuery } = require('./helpers');
const { QUERY_IDS } = require('./query_ids');

const { postLikesQueryId } = QUERY_IDS;

/**
 *
 * @param {Puppeteer.Page} page
 * @param {any} itemSpec
 * @param {any} input
 */
async function getPostLikes(page, itemSpec, input) {
    const limit = input.likedByLimit;
    if (!limit || limit === 0) return [];
    log(itemSpec, `Loading users who liked the post (limit ${limit} items).`);

    const nodeTransformationFunction = (data) => {
        if (!data.shortcode_media) throw new Error('Liked by GraphQL query does not contain shortcode_media');
        if (!data.shortcode_media.edge_liked_by) throw new Error('Liked by GraphQL query does not contain edge_liked_by');
        const likedBy = data.shortcode_media.edge_liked_by;
        const pageInfo = likedBy.page_info;
        const endCursor = pageInfo.end_cursor;
        const likes = likedBy.edges.map((like) => {
            const { node } = like;
            return {
                id: node.id,
                full_name: node.full_name,
                username: node.username,
                profile_pic_url: node.profile_pic_url,
                is_private: node.is_private,
                is_verified: node.is_verified,
            };
        });
        return { nextPageCursor: endCursor, data: likes };
    };

    const variables = {
        shortcode: itemSpec.id,
        include_reel: false,
    };

    return finiteQuery(
        postLikesQueryId,
        variables,
        nodeTransformationFunction,
        limit,
        page,
        input,
        '[post likes]',
    );
}

module.exports = {
    getPostLikes,
};
