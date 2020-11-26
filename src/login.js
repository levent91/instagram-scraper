const Apify = require('apify');
const http = require('http');
const { pleaseOpen, liveView, localhost } = require('./asci-texts.js');
const { authorize, close } = require('./submit-page.js');

const { sleep, puppeteer } = Apify.utils;

/**
 * Attempts log user into instagram with provided username and password
 * @param {String} username Username to use during login (can also be an email or telephone)
 * @param {String} password Password to  use during login
 * @param {Object} page Puppeteer Page object
 * @return Does not return anything
 */
const login = async (username, password, page) => {
    Apify.utils.log.info('Attempting to log in');

    try {
        await page.goto('https://www.instagram.com/accounts/login/?source=auth_switcher');
        await page.waitForSelector('input[name="username"]');
        await page.waitForSelector('input[name="password"]');
        await page.waitForSelector('button[type="submit"]');
        await sleep(1000);

        await page.type('input[name="username"]', username, { delay: 150 });
        await page.type('input[name="password"]', password, { delay: 180 });
        await sleep(1000);

        await page.click('button[type="submit"]');

        await Promise.allSettled([
            page.waitForResponse((response) => response.url().includes('/ajax'), { timeout: 5000 }),
            page.click('button[type="submit"]'),
        ]);

        const invalidCredentials = await page.evaluate(() => {
            return document.querySelector('#slfErrorAlert') !== null;
        });
        if (invalidCredentials) {
            throw new Error('Invalid credentials.');
        }

        await page.waitForNavigation();
        await sleep(1000);

        await page.waitForSelector('form button');
        await page.click('form button');

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

        await page.waitForSelector('input[name="security_code"]');
        await page.waitForSelector('form button');
        await page.type('input[name="security_code"]', code, { delay: 150 });
        await sleep(1000);
        await page.click('form button');

        await page.waitForNavigation();

        Apify.utils.log.info('Successfully logged in');
        await sleep(3000);
    } catch (error) {
        Apify.utils.log.info('Failed to log in');
        Apify.utils.log.error(error);

        // store screenShot in case of failure
        await puppeteer.saveSnapshot(page, {
            key: 'LOGINFAILED',
            saveScreenshot: true,
            saveHtml: true,
        });

        process.exit(1);
    }
};

module.exports = {
    login,
};
