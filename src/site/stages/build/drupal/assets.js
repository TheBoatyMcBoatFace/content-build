const cheerio = require('cheerio');

function replacePathInData(data, replacer, ancestors = new Set()) {
  // Circular references happen when an entity in the CMS has a child entity
  // which is also in its ancestor tree. When this hapens, this function becomes
  // infinitely recursive. This check looks for circular references and, when
  // found, exits early because it's already checked that data.
  if (ancestors.has(data)) return data;

  ancestors.add(data);

  let current = data;
  if (Array.isArray(data)) {
    // This means we're always creating a shallow copy of arrays, but
    // that seems worth the complexity trade-off
    current = data.map(item => replacePathInData(item, replacer, ancestors));
  } else if (!!current && typeof current === 'object') {
    Object.keys(current).forEach(key => {
      let newValue = current;

      if (typeof current[key] === 'string') {
        newValue = replacer(current[key], key);
      } else {
        newValue = replacePathInData(current[key], replacer, ancestors);
      }

      if (newValue !== current[key]) {
        // eslint-disable-next-line prefer-object-spread
        current = Object.assign({}, current, {
          [key]: newValue,
        });
      }
    });
  }

  return current;
}

function convertAssetPath(url) {
  // After this path are other folders in the image paths,
  // but it's hard to tell if we can strip them, so I'm leaving them alone
  // Check that this item is on a VA domain.
  // @todo Allow specified domains not of form *.cms.va.gov.
  // @todo alternately, check against DRUPAL_ADDRESS, accounting for protocol.
  const assetPath = url.replace(
    /^https?:\/\/([a-z0-9]+(-[a-z0-9]+)*\.)+cms\.va\.gov\/sites\/.*\/files\//,
    '',
  );
  // If we still have a fully-qualified absolute URL, just pass it through.
  if (assetPath.match(/^http/)) {
    return assetPath;
  }

  const path = assetPath.split('?', 2)[0];
  // This is sort of naive, but we'd like to have images in the img folder
  if (
    ['png', 'jpg', 'jpeg', 'gif', 'svg'].some(ext =>
      path.toLowerCase().endsWith(ext),
    )
  ) {
    return `/img/${path}`;
  }

  return `/files/${path}`;
}

// Update WYSIWYG asset URLs based on environment (local vs CI)
function updateAttr(attr, doc) {
  const assetsToDownload = [];

  doc(`[${attr}*="cms.va.gov/sites"]`).each((i, el) => {
    const item = doc(el);
    const srcAttr = item.attr(attr);
    // *.ci.cms.va.gov ENVs don't have AWS URLs.
    const newAssetPath = convertAssetPath(srcAttr);

    assetsToDownload.push({
      // URLs in WYSIWYG content won't be the AWS URLs, they'll be CMS URLs.
      // This means we need to replace them with the AWS URLs if we're on Jenkins.
      src: srcAttr,
      dest: newAssetPath,
    });

    item.attr(attr, newAssetPath);
  });

  return assetsToDownload;
}

function convertDrupalFilesToLocal(drupalData, files) {
  return replacePathInData(drupalData, (data, key) => {
    if (data.match(/^.*\/sites\/.*\/files\//)) {
      const newPath = convertAssetPath(data);
      const decodedFileName = decodeURIComponent(newPath).substring(1);
      const htmlRegex = new RegExp(/<\/?[a-z][\s\S]*>/i);
      const vaDomainRegex = new RegExp(
        /^https?:\/\/([a-z0-9]+(-[a-z0-9]+)*\.)+cms\.va\.gov/i,
      );

      // Check that this item is on a VA domain.
      // @todo Allow specified domains not of form *.cms.va.gov.
      // @todo alternately, check against DRUPAL_ADDRESS, accounting for protocol.
      // If this item contains HTML, don't queue it for download
      if (vaDomainRegex.test(data) && !htmlRegex.test(decodedFileName)) {
        // eslint-disable-next-line no-param-reassign
        files[decodedFileName] = {
          path: decodedFileName,
          source: data,
          isDrupalAsset: true,
          contents: '',
        };
      }

      return newPath;
    }

    if (key === 'processed') {
      const doc = cheerio.load(data);
      const assetsToDownload = [
        ...updateAttr('href', doc),
        ...updateAttr('src', doc),
      ];

      if (assetsToDownload.length) {
        assetsToDownload.forEach(({ src, dest }) => {
          const decodedFileName = decodeURIComponent(dest).substring(1);
          // eslint-disable-next-line no-param-reassign
          files[decodedFileName] = {
            path: decodedFileName,
            source: src,
            isDrupalAsset: true,
            contents: '',
          };
        });
      }

      return doc.html();
    }

    return data;
  });
}

module.exports = convertDrupalFilesToLocal;
