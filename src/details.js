/* eslint-disable no-nested-ternary */
const Apify = require('apify');
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
        videoPlayCount: node.video_play_count,
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
            node.comment_count,
            node.comments?.count,
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
    const likes = node.liked_by || node.edge_liked_by || node.edge_media_preview_like;
    const caption = node.caption_text || edgesToText(node.edge_media_to_caption?.edges).join('\n');
    const { hashtags, mentions } = parseCaption(caption);

    return {
        id: node.pk?.toString() || node.id?.toString(),
        // eslint-disable-next-line no-nested-ternary
        type: node.__typename ? node.__typename.replace('Graph', '') : (node.is_video ? 'Video' : 'Image'),
        shortCode: node.shortcode,
        caption,
        hashtags,
        mentions,
        url: node.shortcode ? `https://www.instagram.com/p/${node.shortcode}/` : null,
        commentsCount: comments.count || comments.edges.length || 0,
        firstComment: node.comments?.[0]?.text || node.comments?.edges?.[0]?.node?.text || '',
        latestComments: node.comments?.length ? node.comments.map(({ pk, user, text, created_at }) => ({
            id: pk ?? null,
            ownerUsername: user?.username ?? '',
            text,
            timestamp: secondsToDate(created_at),
        })) : node.comments.edges?.length ? node.comments.edges.map(({ node: { id, owner: { username }, text, created_at } }) => ({
            id,
            ownerUsername: username,
            text,
            timestamp: secondsToDate(created_at),
        })) : [],
        dimensionsHeight: node.dimensionsHeight || node.dimensions?.height,
        dimensionsWidth: node.dimensionsWidth || node.dimensions?.width,
        displayUrl: node.display_url,
        images: node.images ? node.images : sidecarImages(node),
        videoUrl: node.video_url,
        alt: node.accessibility_caption,
        likesCount: likes?.count || likes || null,
        videoViewCount: node.video_view_count,
        videoPlayCount: node.video_play_count,
        timestamp: secondsToDate(node.taken_at_timestamp),
        // childPosts: node.carousel_media?.length ? node.carousel_media?.map?.((child) => formatSinglePost(child.node)) : [],
        // todo: add childPosts
        // since the childpost format is different, we should also map it to the correct format
        childPosts: [],
        locationName: node.location?.name || node.location || null,
        locationId: node.location_id || node.location?.id || null,
        ownerFullName: node.full_name || node.owner?.full_name || null,
        ownerUsername: node.username || node.owner?.username || null,
        ownerId: node.id || node.owner?.id || null,
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

/**
 * Merge responses
 *
 * @param {Record<string, any>} userData
 */

const mergePostDetailInformation = async (userData) => {
    const { misc, info, comments, nonLoginInfo } = userData;
    // info comes when there is a cookie login
    const isVideo = misc?.data?.data?.user?.edge_owner_to_timeline_media?.edges?.[0]?.node?.is_video ?? false;
    if (info) {
        const isCarousel = !!info.data.items?.[0]?.carousel_media?.length;
        return {
            caption_is_edited: comments.data?.caption_is_edited,
            commentsdisabled: misc.data?.data?.user?.edge_owner_to_timeline_media?.edges?.[0]?.node?.comments_disabled,
            location: info.data?.items?.[0]?.location || null,
            location_id: info.data?.items?.[0]?.location?.pk || null,
            full_name: info.data?.items?.[0]?.user?.full_name || null,
            product_type: info.data?.items?.[0]?.user?.product_type || null,
            username: info.data?.items?.[0]?.user?.username || null,
            id: info.data?.items?.[0]?.user?.pk || null,
            edge_media_to_tagged_user: info.data?.items?.[0]?.carousel_media_count ? info.data.items?.[0].carousel_media?.[0]?.usertags?.in : [],
            liked_by: info.data?.items?.[0]?.like_count,
            caption_text: info.data.items?.[0]?.caption?.text,
            comment_count: info.data?.items?.[0]?.comment_count,
            video_play_count: isVideo ? info.data?.items?.[0]?.play_count : null,
            video_view_count: isVideo ? info.data?.items?.[0]?.view_count : null,
            video_duration: isVideo ? info.data?.items?.[0]?.video_duration : null,
            shortcode: info.data.items?.[0]?.code,
            display_url: info.data.items?.[0]?.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url,
            images: isCarousel ? info.data.items?.[0]?.carousel_media.map((item) => item?.image_versions2?.candidates?.[0]?.url) : info.data.items?.[0]?.image_versions2?.candidates?.[0]?.url,
            taken_at_timestamp: info.data?.items?.[0]?.taken_at,
            comments: comments.data?.comments?.reverse() || [],
            carousel_media: isCarousel ? info.data.items?.[0]?.carousel_media : [],
            dimensionsWidth: info.data.items?.[0]?.carousel_media?.original_width || misc?.data?.data?.user?.edge_owner_to_timeline_media?.edges?.[0]?.node?.dimensions?.width,
            dimensionsHeight: info.data.items?.[0]?.carousel_media?.original_height || misc?.data?.data?.user?.edge_owner_to_timeline_media?.edges?.[0]?.node?.dimensions?.height,
            is_video: isVideo,
            video_url: isVideo ? info.data?.items?.[0]?.video_versions?.[0]?.url : null,
        };
    }
    return {
        caption_is_edited: nonLoginInfo.data.data.shortcode_media?.caption_is_edited,
        commentsdisabled: nonLoginInfo.data?.data?.shortcode_media.comments_disabled,
        location: nonLoginInfo.data?.data?.shortcode_media?.location?.name || null,
        location_id: nonLoginInfo.data?.data?.shortcode_media?.location?.id || null,
        full_name: nonLoginInfo.data?.data?.shortcode_media.owner.full_name || null,
        // product_type: info.data?.items?.[0]?.user?.product_type || null,
        username: nonLoginInfo.data?.data?.shortcode_media.owner.username || null,
        id: nonLoginInfo.data?.data?.shortcode_media.owner.id || null,
        edge_media_to_tagged_user: nonLoginInfo.data?.data?.shortcode_media.edge_media_to_tagged_user.edges || [],
        liked_by: nonLoginInfo.data?.data?.shortcode_media.edge_media_preview_like?.count || null,
        caption_text: nonLoginInfo.data.data.shortcode_media?.edge_media_to_caption?.edges?.[0]?.node?.text,
        comment_count: nonLoginInfo.data?.data?.shortcode_media.edge_media_to_comment?.count,
        video_play_count: isVideo ? nonLoginInfo.data?.data?.shortcode_media?.video_play_count : null,
        video_view_count: isVideo ? nonLoginInfo.data?.data?.shortcode_media?.video_view_count : null,
        video_duration: isVideo ? nonLoginInfo.data?.data?.shortcode_media?.video_duration : null,
        shortcode: nonLoginInfo.data?.data?.shortcode_media?.shortcode,
        display_url: nonLoginInfo.data?.data?.shortcode_media?.display_url,
        images: nonLoginInfo.data?.data?.shortcode_media?.edge_sidecar_to_children?.edges?.map((item) => item?.node?.display_resources?.[0]?.src),
        taken_at_timestamp: nonLoginInfo.data?.data?.shortcode_media?.taken_at_timestamp,
        comments: nonLoginInfo.data?.data?.shortcode_media?.edge_media_to_parent_comment || [],
        // carousel_media: isCarousel ? info.data.items?.[0]?.carousel_media : [],
        dimensionsWidth: nonLoginInfo.data?.data?.shortcode_media?.dimensions?.width,
        dimensionsHeight: nonLoginInfo.data?.data?.shortcode_media?.dimensions?.height,
        is_video: isVideo,
        video_url: isVideo ? nonLoginInfo.data?.data?.shortcode_media?.video_url : null,
    };
};

module.exports = {
    formatIGTVVideo,
    formatDisplayResources,
    createAddProfile,
    formatSinglePost,
    mergePostDetailInformation,
};
