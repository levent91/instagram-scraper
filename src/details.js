const Apify = require('apify'); // eslint-disable-line no-unused-vars
const { parseCaption, mapNode, mapProp, edgesToText, dedupById, secondsToDate } = require('./helpers');
const consts = require('./consts');

const { PAGE_TYPES } = consts;

/**
 * Formats IGTV Video Post edge item into nicely formated output item
 *
 * @param {Record<string, any>} edge
 */
const formatIGTVVideo = (edge) => {
    const { node } = edge;

    return {
        type: 'Video',
        shortCode: node.shortcode,
        title: node.title,
        caption: edgesToText(node.edge_media_to_caption?.edges).join('\n') || '',
        commentsCount: node.edge_media_to_comment?.count,
        commentsDisabled: node.comments_disabled,
        dimensionsHeight: node.dimensions.height,
        dimensionsWidth: node.dimensions.width,
        displayUrl: node.display_url,
        likesCount: node.edge_liked_by ? node.edge_liked_by.count : null,
        videoDuration: node.video_duration || 0,
        videoViewCount: node.video_view_count,
    };
};

/**
 * Formats list of display recources into URLs
 * @param {Array<Record<string, any>>} resources
 */
const formatDisplayResources = (resources) => {
    return (resources ?? []).map(mapNode).map(mapProp('display_url')).filter(Boolean);
};

/**
 *
 * @param {Record<string, any>} node
 */
const sidecarImages = (node) => formatDisplayResources(node.edge_sidecar_to_children?.edges);

/**
 * Format Post Edge item into cleaner output
 *
 * @param {Record<string, any>} node
 */
const formatSinglePost = (node) => {
    const comments = {
        count: [
            node.edge_media_to_comment?.count,
            node.edge_media_to_parent_comment?.count,
            node.edge_media_preview_comment?.count,
            node.edge_media_to_hoisted_comment?.count,
        ].reduce((out, count) => (count > out ? count : out), 0), // Math.max won't work here
        edges: dedupById([
            node.edge_media_to_comment?.edges,
            node.edge_media_to_parent_comment?.edges,
            node.edge_media_preview_comment?.edges,
            node.edge_media_to_hoisted_comment?.edges,
        ].flat().map(mapNode)),
    };
    const likes = node.edge_liked_by || node.edge_media_preview_like;
    const caption = edgesToText(node.edge_media_to_caption?.edges).join('\n');
    const { hashtags, mentions } = parseCaption(caption);

    return {
        id: node.id,
        // eslint-disable-next-line no-nested-ternary
        type: node.__typename ? node.__typename.replace('Graph', '') : (node.is_video ? 'Video' : 'Image'),
        shortCode: node.shortcode,
        caption,
        hashtags,
        mentions,
        url: node.shortcode ? `https://www.instagram.com/p/${node.shortcode}/` : null,
        commentsCount: comments.count || comments.edges.length || 0,
        firstComment: comments?.edges?.[0]?.text ?? '',
        latestComments: comments.edges.map(({ id, owner, text, created_at }) => ({
            id,
            ownerUsername: owner?.username ?? '',
            text,
            timestamp: secondsToDate(created_at),
        })),
        dimensionsHeight: node.dimensions.height,
        dimensionsWidth: node.dimensions.width,
        displayUrl: node.display_url,
        images: sidecarImages(node),
        videoUrl: node.video_url,
        alt: node.accessibility_caption,
        likesCount: likes?.count ?? null,
        videoViewCount: node.video_view_count,
        timestamp: secondsToDate(node.taken_at_timestamp),
        childPosts: node.edge_sidecar_to_children?.edges?.map?.((child) => formatSinglePost(child.node)) ?? [],
        locationName: node.location?.name ?? null,
        locationId: node.location?.id ?? null,
        ownerFullName: node?.owner?.full_name ?? null,
        ownerUsername: node?.owner?.username ?? null,
        ownerId: node?.owner?.id ?? null,
        productType: node.product_type,
        isSponsored: node.is_ad,
        videoDuration: node.video_duration,
    };
};

/**
 * Add a profile to extract details
 *
 * @param {Apify.RequestQueue} requestQueue
 */
const createAddProfile = (requestQueue) => {
    /**
     * @param {string} username
     */
    return async (username) => {
        const url = new URL(username, 'https://www.instagram.com');

        return requestQueue.addRequest({
            url: url.toString(),
            userData: {
                pageType: PAGE_TYPES.PROFILE,
            },
        });
    };
};

module.exports = {
    formatIGTVVideo,
    formatDisplayResources,
    createAddProfile,
    formatSinglePost,
};
