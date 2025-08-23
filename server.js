const app = require('./src/app');
const { startObserverCleanupJob } = require('./src/jobs/observerCleanup');

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  // Start background job: runs every 24 hours to clean up expired observers
  startObserverCleanupJob(86_400_000); // 24 * 60 * 60 * 1000
  // this is for testing 
  // startObserverCleanupJob(12); 
});
