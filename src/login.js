const Apify = require('apify');
const Puppeteer = require('puppeteer'); // eslint-disable-line no-unused-vars

/**
 *
 * @param {{
 *  loginCookies?: any[] | Array<any[]>,
 *  maxErrorCount: number,
 * }} param
 */
const loginManager = async ({ loginCookies, maxErrorCount }) => {
    /**
     * @type {Map<number, { index: number, uses: number, errors: number, cookies: any[] }>}
     */
    const logins = new Map((await Apify.getValue('LOGIN_STATE')) || []);

    const saveLoginState = async () => {
        await Apify.setValue('LOGIN_STATE', [...logins.entries()]);
    };

    Apify.events.on('aborting', saveLoginState);
    Apify.events.on('migrating', saveLoginState);

    if (Array.isArray(loginCookies?.[0])) {
        loginCookies?.forEach((cookies, index) => {
            logins.set(index, {
                index,
                uses: 0,
                errors: 0,
                cookies,
            });
        });
    } else if (Array.isArray(loginCookies) && loginCookies?.length > 0) {
        logins.set(0, {
            index: 0,
            uses: 0,
            errors: 0,
            cookies: loginCookies,
        });
    }

    if (!logins.size) {
        throw new Error('No usable loginCookies from input');
    }

    return {
        loginCount() {
            return logins.size;
        },
        /**
         * @param {Apify.Session} session
         */
        hasSession(session) {
            const { loginIndex } = session.userData;
            return loginIndex !== undefined && logins.get(loginIndex);
        },
        /**
         * @param {Apify.Session} session
         */
        isUsable(session) {
            const { loginIndex } = session.userData;
            if (loginIndex === undefined) {
                return true;
            }
            const data = logins.get(loginIndex);
            if (!data) {
                return true;
            }
            return session.isUsable() && data.errors < maxErrorCount;
        },
        /**
         * @param {Apify.Session} session
         */
        decreaseError(session) {
            const { loginIndex } = session.userData;
            const l = logins.get(loginIndex);
            if (!l) {
                return;
            }

            if (l.errors > 0) {
                l.errors--;
            }
            l.uses++;
        },
        /**
         * @param {Apify.Session} session
         */
        increaseError(session) {
            const { loginIndex } = session.userData;
            const l = logins.get(loginIndex);
            if (!l) {
                return;
            }
            l.errors++;
            l.uses++;
        },
        /**
         * @param {Puppeteer.Page} page
         * @param {Apify.Session} session
         */
        async setCookie(page, session) {
            if (!logins.size) {
                return true;
            }

            for (const l of logins.values()) {
                if (l.errors < maxErrorCount) {
                    await page.setCookie(...l.cookies
                        .filter((s) => `${s.domain}`.includes('instagram'))
                        .map(({
                            expirationDate,
                            id,
                            storeId,
                            size,
                            sourceScheme,
                            sourcePort,
                            ...s
                        }) => ({ ...s, domain: '.instagram.com' })));

                    session.userData.loginIndex = l.index;

                    return true;
                }
            }

            return false;
        },
    };
};

module.exports = {
    loginManager,
};
