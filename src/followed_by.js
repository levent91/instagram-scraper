// eslint-disable-next-line no-unused-vars
const Puppeteer = require('puppeteer');
const { log, finiteQuery } = require('./helpers');
const { QUERY_IDS } = require('./query_ids');

const { profileFollowersQueryId } = QUERY_IDS;

/**
 *
 * @param {Puppeteer.Page} page
 * @param {any} itemSpec
 * @param {any} input
 */
async function getProfileFollowedBy(page, itemSpec, input) {
    const limit = input.followedByLimit;
    if (!limit) return undefined;

    log(itemSpec, `Loading users current profile followed by (limit ${limit} items).`);

    const nodeTransformationFunction = (data) => {
        if (!data.user) throw new Error('"Followed by" GraphQL query does not contain user object');
        if (!data.user.edge_followed_by) throw new Error('"Followed by" GraphQL query does not contain edge_followed_by object');
        const followedBy = data.user.edge_followed_by;
        const pageInfo = followedBy.page_info;
        const endCursor = pageInfo.end_cursor;
        const users = followedBy.edges.map((followedByItem) => {
            const { node } = followedByItem;
            return {
                id: node.id,
                full_name: node.full_name,
                username: node.username,
                profile_pic_url: node.profile_pic_url,
                is_private: node.is_private,
                is_verified: node.is_verified,
            };
        });
        return { nextPageCursor: endCursor, data: users };
    };

    const variables = {
        id: itemSpec.userId,
        include_reel: false,
        fetch_mutual: false,
    };

    return finiteQuery(
        profileFollowersQueryId,
        variables,
        nodeTransformationFunction,
        limit,
        page,
        input,
        '[profile followed by]',
    );
}

module.exports = {
    getProfileFollowedBy,
};
