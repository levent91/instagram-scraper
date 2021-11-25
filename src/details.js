const Apify = require('apify'); // eslint-disable-line no-unused-vars
const { parseCaption } = require('./helpers');
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
        caption: node?.edge_media_to_caption?.edges?.length ? node.edge_media_to_caption.edges[0].node.text : '',
        commentsCount: node.edge_media_to_comment.count,
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
    if (!resources) return [];
    return resources.map((resource) => resource.node.display_url).filter((s) => s);
};

/**
 *
 * @param {Record<string, any>} node
 */
const sidecarImages = (node) => {
    return node?.edge_sidecar_to_children?.edges?.length
        ? formatDisplayResources(node.edge_sidecar_to_children.edges)
        : [];
};

/**
 * Format Post Edge item into cleaner output
 *
 * @param {Record<string, any>} node
 */
const formatSinglePost = (node) => {
    const comments = {
        count: Math.max(...[
            node.edge_media_to_comment?.count,
            node.edge_media_to_parent_comment?.count,
            node.edge_media_preview_comment?.count,
            node.edge_media_to_hoisted_comment?.count,
        ].filter(Boolean)),
        edges: [
            ...(node.edge_media_to_comment?.edges ?? []),
            ...(node.edge_media_to_parent_comment?.edges ?? []),
            ...(node.edge_media_preview_comment?.edges ?? []),
            ...(node.edge_media_to_hoisted_comment?.edges ?? []),
        ],
    };
    const likes = node.edge_liked_by || node.edge_media_preview_like;
    const caption = node?.edge_media_to_caption?.edges?.length
        ? node.edge_media_to_caption.edges.reduce((out, { node: { text } }) => `${out}\n${text}`, '')
        : '';
    const { hashtags, mentions } = parseCaption(caption);

    return {
        // eslint-disable-next-line no-nested-ternary
        type: node.__typename ? node.__typename.replace('Graph', '') : (node.is_video ? 'Video' : 'Image'),
        shortCode: node.shortcode,
        caption,
        hashtags,
        mentions,
        url: `https://www.instagram.com/p/${node.shortcode}`,
        commentsCount: comments?.count ?? 0,
        latestComments: comments?.edges?.length ? comments.edges.map((edge) => ({
            ownerUsername: edge.node.owner ? edge.node.owner.username : '',
            text: edge.node.text,
        })).reverse() : [],
        dimensionsHeight: node.dimensions.height,
        dimensionsWidth: node.dimensions.width,
        displayUrl: node.display_url,
        images: sidecarImages(node),
        videoUrl: node.video_url,
        id: node.id,
        firstComment: comments?.edges?.[0]?.node?.text ?? '',
        alt: node.accessibility_caption,
        likesCount: likes?.count ?? null,
        videoViewCount: node.video_view_count,
        timestamp: node.taken_at_timestamp
            ? new Date(node.taken_at_timestamp * 1000).toISOString()
            : null,
        locationName: node.location?.name ?? null,
        locationId: node.location?.id ?? null,
        ownerFullName: node.owner ? node.owner.full_name : null,
        ownerUsername: node.owner ? node.owner.username : null,
        ownerId: node.owner ? node.owner.id : null,
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
