### 2021-08-02

Features:
- Update to SDK 2
- Better UX

Bug fixes:
- Stories
- Scrolling for hashtag, posts, comments and location
- Login cookies and management
- Cookies export
- Lessen the redirects
- Proper datacenter proxy support
- Implemented Extend Output Function

### 2021-03-16

#### Bug fixes
- Fix login cookies

#### New features
- Added `images` to the dataset
- Update to SDK 1.0.2

### 2020-10-17 Bug fixes and some improvements

#### Bug fixes
- Hotfix for pages not loading properly
- Accept cookies modal when it's shown
- Fix Unicode URLs
- Fix scrolling with posts with body scroll
- Remove legacy code
- Some linting
- Support for Unicode hashtags and mentions

#### New features
- Added scraping of profile stories
- Added option to pass a list of `loginCookies` to rotate logged-in accounts

### 2020-06-11 Big update with many fixes and new features

#### Bug fixes
- Blocked pages are immediately retried with another browser and IP address
- Pages that sometimes don’t load properly are immediately retried
- Posts and comments scroll down properly and are fully scraped
- Fixed some missing data points for posts and comments
- Reduced overall assets size so it consumes less network traffic (cheaper residential proxy)

#### New features
- Posts and comments are pushed as the page is scrolling (no need to wait for full scroll to get first data)
- Optional login with cookies
- Scrape posts until a specified date
- Expand post data with user detail info
- Optional following, followed and likes (requires login)
- Custom user-provided function to enhance the output (without need to change the code)
- Extracting mentions and hashtags from post captions
- Added more data points for users, posts and comments (don’t remember exactly check new readme)
- More descriptive log (shows current scraped posts/comments vs total)
