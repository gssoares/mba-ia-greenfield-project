export const QUEUES = {
  VIDEO_PROCESSING: 'video-processing',
  VIDEO_MAINTENANCE: 'video-maintenance',
} as const;

export const JOBS = {
  PROCESS_VIDEO: 'process-video',
  PURGE_STALE_UPLOADS: 'purge-stale-uploads',
} as const;

export const SCHEDULES = {
  PURGE_STALE_UPLOADS_CRON: '0 0 * * * *',
} as const;
