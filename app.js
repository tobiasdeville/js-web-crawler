// app.js
import WebCrawler from './WebCrawler.js'; // Assuming your provided code is in WebCrawler.js

async function runCrawler() {
  const startUrl = 'https://www.example.com'; // **CHANGE THIS TO A REAL URL YOU WANT TO CRAWL**

  const crawler = new WebCrawler({
    maxDepth: 1, // Limiting depth for a quick test
    maxPages: 10, // Limiting pages for a quick test
    // You can add more options here
  });

  // Listen for events (optional, but good for seeing progress)
  crawler.on('page', (pageResult) => {
    console.log(`Crawled: ${pageResult.url} (Depth: ${pageResult.depth})`);
  });

  crawler.on('error', (errorData) => {
    console.error(`Error crawling ${errorData.url}: ${errorData.error.message}`);
  });

  crawler.on('complete', ({ results, summary }) => {
    console.log('\n--- Crawl Complete ---');
    console.log('Summary:', summary);
    // console.log('Results:', results.map(r => r.url)); // Uncomment to see all crawled URLs
  });

  try {
    const { results, summary } = await crawler.crawl(startUrl);
    console.log('\nCrawl function returned results and summary:', { resultsCount: results.length, summary });
  } catch (error) {
    console.error('Crawler encountered a fatal error:', error);
  }
}

runCrawler();
