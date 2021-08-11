const Apify = require('apify');
const Puppeteer = require('puppeteer'); // eslint-disable-line no-unused-vars
const http = require('http');
const { acceptCookiesDialog } = require('./helpers');
const { pleaseOpen, liveView, localhost } = require('./asci-texts');
const { authorize, close } = require('./submit-page');

const { sleep, puppeteer } = Apify.utils;

/**
 * Attempts log user into instagram with provided username and password
 * @param {String} username Username to use during login (can also be an email or telephone)
 * @param {String} password Password to  use during login
 * @param {Puppeteer.Page} page Puppeteer Page object
 * @return Does not return anything
 */
const login = async (username, password, page) => {
    Apify.utils.log.info('Attempting to log in');

    try {
        await page.goto('https://www.instagram.com/accounts/login/?source=auth_switcher');

        await Promise.all([
            page.waitForSelector('input[name="username"]', { visible: true, timeout: 15000 }),
            page.waitForSelector('input[name="password"]', { visible: true, timeout: 15000 }),
            page.waitForSelector('button[type="submit"]', { visible: true, timeout: 15000 }),
        ]);

        // need to click the accept cookies dialog if it's showing
        await acceptCookiesDialog(page);

        await page.type('input[name="username"]', username, { delay: 150 });
        await page.type('input[name="password"]', password, { delay: 180 });

        await Promise.allSettled([
            page.waitForResponse((response) => response.url().includes('/login'), { timeout: 15000 }),
            page.click('button[type="submit"]'),
        ]);

        try {
            await page.waitForSelector('#slfErrorAlert', { timeout: 5000 });

            throw new Error('Invalid credentials.');
        } catch (e) {
            if (e.message.includes('Invalid')) {
                throw e;
            }
        }

        // Wait fo code sent to email
        const port = Apify.isAtHome() ? process.env.APIFY_CONTAINER_PORT : 3000;
        const information = Apify.isAtHome() ? liveView : localhost;

        console.log(pleaseOpen);
        console.log(information);
        let code;

        const server = http.createServer((req, res) => {
            if (req.url.includes('/authorize')) {
                let data = '';
                req.on('data', (body) => {
                    if (body) data += body;
                });
                req.on('end', () => {
                    code = decodeURIComponent(data.replace('code=', ''));
                    res.end(close());
                });
            } else {
                res.end(authorize());
            }
        });

        server.listen(port, () => console.log('server is listening on port', port));

        const start = Date.now();
        while (!code) {
            const now = Date.now();
            if (now - start > 5 * 60 * 1000) {
                throw new Error('You did not provide the code in time!');
            }
            console.log(`waiting for code...You have ${300 - Math.floor((now - start) / 1000)} seconds left`);
            await new Promise((resolve) => setTimeout(resolve, 10000));
        }
        server.close(() => console.log('closing server'));

        await Promise.race([
            page.waitForSelector('input[name="security_code"]', { timeout: 5000 }),
            page.waitForSelector('input[name="verificationCode"]', { timeout: 5000 }),
        ]);

        await page.waitForSelector('form button');
        await page.type('input[name="verificationCode"],input[name="security_code"]', code, { delay: 150 });
        await sleep(1000);
        await page.click('form button');

        await page.waitForNavigation();

        try {
            // click second button if it exists
            const itWasMe = 'form > div:not(:first-of-type) button[name="choice"]';
            await page.waitForSelector(itWasMe);
            await page.click(itWasMe);
            await page.waitForNavigation();
        } catch (e) {
        }

        Apify.utils.log.info('Successfully logged in');
        await Apify.utils.sleep(3000);
    } catch (error) {
        Apify.utils.log.exception(error, 'Failed to log in');

        // store screenShot in case of failure
        await puppeteer.saveSnapshot(page, {
            key: 'LOGINFAILED',
            saveScreenshot: true,
            saveHtml: true,
        });

        process.exit(1);
    }
};

/**
 *
 * @param {{
 *  loginCookies?: any[] | Array<any[]>,
 *  maxErrorCount: number,
 * }} param
 */
const loginManager = ({ loginCookies, maxErrorCount }) => {
    /**
     * @type {Map<number, { index: number, uses: number, errors: number, cookies: any[] }>}
     */
    const logins = new Map();

    if (loginCookies && loginCookies.length > 0) {
        if (Array.isArray(loginCookies[0])) {
            loginCookies.forEach((cookies, index) => {
                logins.set(index, {
                    index,
                    uses: 0,
                    errors: 0,
                    cookies,
                });
            });
        } else {
            logins.set(0, {
                index: 0,
                uses: 0,
                errors: 0,
                cookies: loginCookies,
            });
        }
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
    login,
    loginManager,
};
