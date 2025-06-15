import axios from 'axios';
import * as cheerio from 'cheerio';
import URL from 'url-parse';
import robotsParser from 'robots-parser';
import pLimit from 'p-limit';
import { EventEmitter } from 'events';
import logger from './logger.js';

class WebCrawler extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      maxDepth: options.maxDepth || 3,
      maxPages: options.maxPages || 100,
      maxConcurrency: options.maxConcurrency || 5,
      delay: options.delay || 1000,
      timeout: options.timeout || 30000,
      followExternalLinks: options.followExternalLinks || false,
      respectRobotsTxt: options.respectRobotsTxt || true,
      userAgent: options.userAgent || 'WebCrawler-JS/1.0',
      allowedDomains: options.allowedDomains || [],
      excludePatterns: options.excludePatterns || [],
      includePatterns: options.includePatterns || [],
      maxRetries: options.maxRetries || 3,
      ...options
    };

    this.visitedUrls = new Set();
    this.failedUrls = new Set();
    this.results = [];
    this.robotsCache = new Map();
    this.limit = pLimit(this.options.maxConcurrency);
    
    // Setup axios instance
    this.httpClient = axios.create({
      timeout: this.options.timeout,
      headers: {
        'User-Agent': this.options.userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    // Add response interceptor for handling redirects and errors
    this.httpClient.interceptors.response.use(
      response => response,
      error => {
        if (error.response) {
          logger.warn(`HTTP ${error.response.status}: ${error.config.url}`);
        } else if (error.request) {
          logger.warn(`Network error: ${error.config.url}`);
        }
        return Promise.reject(error);
      }
    );
  }

  async crawl(startUrl) {
    logger.info(`Starting crawl from: ${startUrl}`);
    
    const startTime = Date.now();
    const queue = [{ url: startUrl, depth: 0, parent: null }];
    
    try {
      while (queue.length > 0 && this.results.length < this.options.maxPages) {
        const batch = queue.splice(0, this.options.maxConcurrency);
        const promises = batch.map(item => 
          this.limit(() => this.crawlPage(item.url, item.depth, item.parent))
        );
        
        const batchResults = await Promise.allSettled(promises);
        
        for (let i = 0; i < batchResults.length; i++) {
          const result = batchResults[i];
          const item = batch[i];
          
          if (result.status === 'fulfilled' && result.value) {
            const crawlResult = result.value;
            this.results.push(crawlResult);
            
            // Add new URLs to queue if within depth limit
            if (item.depth < this.options.maxDepth) {
              const newUrls = await this.extractAndFilterUrls(
                crawlResult.links, 
                crawlResult.url, 
                item.depth + 1
              );
              
              newUrls.forEach(url => {
                if (!this.visitedUrls.has(url) && !this.failedUrls.has(url)) {
                  queue.push({ url, depth: item.depth + 1, parent: crawlResult.url });
                }
              });
            }
            
            this.emit('page', crawlResult);
          } else if (result.status === 'rejected') {
            logger.error(`Failed to crawl ${item.url}: ${result.reason.message}`);
            this.failedUrls.add(item.url);
            this.emit('error', { url: item.url, error: result.reason });
          }
        }
        
        // Respect delay between batches
        if (queue.length > 0 && this.options.delay > 0) {
          await this.sleep(this.options.delay);
        }
      }
      
      const endTime = Date.now();
      const summary = {
        totalPages: this.results.length,
        failedPages: this.failedUrls.size,
        totalTime: endTime - startTime,
        averageTime: this.results.length > 0 ? (endTime - startTime) / this.results.length : 0
      };
      
      logger.info(`Crawl completed: ${JSON.stringify(summary)}`);
      this.emit('complete', { results: this.results, summary });
      
      return { results: this.results, summary };
      
    } catch (error) {
      logger.error(`Crawl failed: ${error.message}`);
      this.emit('error', error);
      throw error;
    }
  }

  async crawlPage(url, depth = 0, parent = null) {
    if (this.visitedUrls.has(url)) {
      return null;
    }

    this.visitedUrls.add(url);
    
    // Check robots.txt
    if (this.options.respectRobotsTxt && !(await this.isAllowedByRobots(url))) {
      logger.debug(`Blocked by robots.txt: ${url}`);
      return null;
    }

    const startTime = Date.now();
    let retries = 0;
    
    while (retries <= this.options.maxRetries) {
      try {
        logger.debug(`Crawling (depth ${depth}): ${url}`);
        
        const response = await this.httpClient.get(url);
        const endTime = Date.now();
        
        // Only process HTML content
        const contentType = response.headers['content-type'] || '';
        if (!contentType.includes('text/html')) {
          logger.debug(`Skipping non-HTML content: ${url}`);
          return null;
        }

        const $ = cheerio.load(response.data);
        
        // Extract page information
        const result = {
          url: response.request.res.responseUrl || url,
          originalUrl: url,
          title: $('title').text().trim() || 'No title',
          description: $('meta[name="description"]').attr('content') || '',
          keywords: $('meta[name="keywords"]').attr('content') || '',
          headings: this.extractHeadings($),
          links: this.extractLinks($, url),
          images: this.extractImages($, url),
          statusCode: response.status,
          contentLength: response.data.length,
          contentType: contentType,
          crawlTime: endTime - startTime,
          depth: depth,
          parent: parent,
          timestamp: new Date().toISOString()
        };

        return result;
        
      } catch (error) {
        retries++;
        if (retries > this.options.maxRetries) {
          throw error;
        }
        
        logger.warn(`Retry ${retries}/${this.options.maxRetries} for ${url}: ${error.message}`);
        await this.sleep(1000 * retries); // Exponential backoff
      }
    }
  }

  extractHeadings($) {
    const headings = {};
    ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].forEach(tag => {
      headings[tag] = [];
      $(tag).each((i, el) => {
        const text = $(el).text().trim();
        if (text) {
          headings[tag].push(text);
        }
      });
    });
    return headings;
  }

  extractLinks($, baseUrl) {
    const links = [];
    const baseUrlObj = new URL(baseUrl);
    
    $('a[href]').each((i, el) => {
      const href = $(el).attr('href');
      if (href) {
        try {
          const absoluteUrl = new URL(href, baseUrl).toString();
          const linkText = $(el).text().trim();
          
          links.push({
            url: absoluteUrl,
            text: linkText,
            title: $(el).attr('title') || ''
          });
        } catch (error) {
          logger.debug(`Invalid URL: ${href}`);
        }
      }
    });
    
    return links;
  }

  extractImages($, baseUrl) {
    const images = [];
    
    $('img[src]').each((i, el) => {
      const src = $(el).attr('src');
      if (src) {
        try {
          const absoluteUrl = new URL(src, baseUrl).toString();
          
          images.push({
            url: absoluteUrl,
            alt: $(el).attr('alt') || '',
            title: $(el).attr('title') || '',
            width: $(el).attr('width') || '',
            height: $(el).attr('height') || ''
          });
        } catch (error) {
          logger.debug(`Invalid image URL: ${src}`);
        }
      }
    });
    
    return images;
  }

  async extractAndFilterUrls(links, baseUrl, depth) {
    const baseUrlObj = new URL(baseUrl);
    const filteredUrls = [];
    
    for (const link of links) {
      const url = link.url;
      const urlObj = new URL(url);
      
      // Skip non-HTTP(S) URLs
      if (!['http:', 'https:'].includes(urlObj.protocol)) {
        continue;
      }
      
      // Check domain restrictions
      if (!this.options.followExternalLinks && urlObj.hostname !== baseUrlObj.hostname) {
        continue;
      }
      
      if (this.options.allowedDomains.length > 0 && 
          !this.options.allowedDomains.includes(urlObj.hostname)) {
        continue;
      }
      
      // Check exclude patterns
      if (this.options.excludePatterns.some(pattern => 
          new RegExp(pattern).test(url))) {
        continue;
      }
      
      // Check include patterns
      if (this.options.includePatterns.length > 0 && 
          !this.options.includePatterns.some(pattern => 
            new RegExp(pattern).test(url))) {
        continue;
      }
      
      filteredUrls.push(url);
    }
    
    return [...new Set(filteredUrls)]; // Remove duplicates
  }

  async isAllowedByRobots(url) {
    try {
      const urlObj = new URL(url);
      const robotsUrl = `${urlObj.protocol}//${urlObj.host}/robots.txt`;
      
      if (!this.robotsCache.has(robotsUrl)) {
        try {
          const response = await this.httpClient.get(robotsUrl);
          const robots = robotsParser(robotsUrl, response.data);
          this.robotsCache.set(robotsUrl, robots);
        } catch (error) {
          // If robots.txt doesn't exist or can't be fetched, allow crawling
          this.robotsCache.set(robotsUrl, null);
        }
      }
      
      const robots = this.robotsCache.get(robotsUrl);
      return robots ? robots.isAllowed(url, this.options.userAgent) : true;
      
    } catch (error) {
      logger.debug(`Error checking robots.txt for ${url}: ${error.message}`);
      return true; // Allow crawling if robots.txt check fails
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Utility methods
  getResults() {
    return this.results;
  }

  getVisitedUrls() {
    return Array.from(this.visitedUrls);
  }

  getFailedUrls() {
    return Array.from(this.failedUrls);
  }

  getSummary() {
    return {
      totalPages: this.results.length,
      visitedUrls: this.visitedUrls.size,
      failedUrls: this.failedUrls.size,
      uniqueDomains: new Set(this.results.map(r => new URL(r.url).hostname)).size
    };
  }
}

export default WebCrawler;
