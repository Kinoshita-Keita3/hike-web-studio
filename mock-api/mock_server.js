// Browser Mock Web API Module for Practice
class MockApiService {
  constructor() {
    this.endpoints = {
      '/api/v1/status': { status: 200, body: { server: 'Hike Engine', status: 'healthy' } },
      '/api/v1/data': { status: 200, body: { id: 101, items: [10, 20, 30] } }
    };
  }

  async fetch(url) {
    console.log(`[MockAPI] Simulated HTTP GET Request to: ${url}`);
    if (this.endpoints[url]) {
      return {
        status: this.endpoints[url].status,
        json: async () => this.endpoints[url].body
      };
    }
    return {
      status: 404,
      json: async () => ({ error: 'Not Found' })
    };
  }
}

window.mockApi = new MockApiService();
