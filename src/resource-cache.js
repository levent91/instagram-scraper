const Apify = require('apify');
// eslint-disable-next-line no-unused-vars
const Puppeteer = require('puppeteer');

const { log } = Apify.utils;

const images = {
    png: {
        contentType: 'image/png',
        headers: {
            'access-control-allow-origin': '*',
            'cache-control': 'max-age=1209600, no-transform',
        },
        body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVQYV2P4DwABAQEAWk1v8QAAAABJRU5ErkJggg==', 'base64'),
    },
    gif: {
        contentType: 'image/gif',
        headers: {
            'access-control-allow-origin': '*',
            'cache-control': 'max-age=1209600, no-transform',
        },
        body: Buffer.from('R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=', 'base64'),
    },
    jpg: {
        contentType: 'image/jpeg',
        headers: {
            'access-control-allow-origin': '*',
            'cache-control': 'max-age=1209600, no-transform',
        },
        body: Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'),
    },
};

/**
 * @typedef {Map<string, { loaded: boolean, contentType?: string, content?: Buffer, headers?: any }>} CachedMap
 */

/**
 * Cache page resources depending on regex paths
 * @param {RegExp[]} paths
 * @return {(page: Puppeteer.Page) => Promise<void>}
 */
const resourceCache = (paths) => {
    /**
     * Cache resources to ease the data transfer
     * @type {CachedMap}
     */
    const cache = new Map();

    return async (page) => {
        await page.setRequestInterception(true);

        page.on('request', async (req) => {
            try {
                if (page.isClosed()) {
                    page.removeAllListeners('request');
                    return;
                }

                const url = req.url();

                if (req.resourceType() === 'image') {
                    // serve empty images so the `onload` events don't fail
                    if (url.includes('.jpg') || url.includes('.jpeg')) {
                        return await req.respond(images.jpg);
                    }

                    if (url.includes('.png')) {
                        return await req.respond(images.png);
                    }

                    if (url.includes('.gif')) {
                        return await req.respond(images.gif);
                    }
                } else if (['script', 'stylesheet'].includes(req.resourceType()) && paths.some((path) => path.test(url))) {
                    const content = cache.get(url);

                    // log.debug('Cache', { url, headers: content?.headers, type: content?.contentType, length: content?.content?.length });

                    if (content?.loaded === true) {
                        return await req.respond({
                            body: content.content,
                            status: 200,
                            contentType: content.contentType,
                            headers: content.headers,
                        });
                    }

                    cache.set(url, {
                        loaded: false,
                    });
                }

                await req.continue();
            } catch (e) {
                // page closed, most likely
            }
        });

        page.on('response', async (res) => {
            try {
                if (page.isClosed()) {
                    page.removeAllListeners('response');
                    return;
                }

                if (['script', 'stylesheet'].includes(res.request().resourceType())) {
                    const url = res.url();
                    const content = cache.get(url);

                    if (content && !content.loaded) {
                        const buffer = await res.buffer();

                        /* eslint-disable */
                        const {
                            date,
                            expires,
                            'last-modified': lastModified,
                            'content-length': contentLength,
                            ...headers
                        } = res.headers();
                        /* eslint-enable */

                        cache.set(url, {
                            contentType: res.headers()['content-type'],
                            loaded: buffer.length > 0,
                            content: buffer,
                            headers: {
                                ...headers,
                                'access-control-allow-origin': '*',
                                'cache-control': 'max-age=1209600, no-transform',
                            },
                        });
                    }
                }
            } catch (e) {
                log.debug('Cache error', { e: e.message });
            }
        });
    };
};

module.exports = { resourceCache };
