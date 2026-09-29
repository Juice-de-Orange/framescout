// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// GH Pages publishes under <username>.github.io/<repo>.
// Override SITE / BASE in CI when serving from a custom domain.
const SITE = process.env.SITE_URL ?? 'https://juice-de-orange.github.io';
const BASE = process.env.SITE_BASE ?? '/framescout';

export default defineConfig({
  site: SITE,
  base: BASE,
  integrations: [
    starlight({
      title: 'Framescout',
      description:
        'Wildlife-camera frame pipeline. Source × Detector × Sink, in TypeScript.',
      // Starlight 0.33 changed `social` from an object to an array.
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/Juice-de-Orange/framescout',
        },
      ],
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { label: 'Quickstart', link: '/quickstart/' },
            { label: 'Operator UI', link: '/operator-ui/' },
            { label: 'Configuration reference', link: '/configuration-reference/' },
            { label: 'Troubleshooting', link: '/troubleshooting/' },
          ],
        },
        {
          label: 'Plugins (built-in)',
          items: [
            { label: 'Source: Reolink Hub', link: '/sources/reolink-hub/' },
            { label: 'Detector: MegaDetector (HTTP)', link: '/detectors/megadetector-http/' },
            { label: 'Detector: DeepFaune (HTTP)', link: '/detectors/deepfaune-http/' },
            { label: 'DeepFaune license FAQ', link: '/deepfaune-license-faq/' },
            { label: 'Sink: HTTP Multipart', link: '/sinks/http-multipart/' },
            { label: 'Sink: MQTT', link: '/sinks/mqtt/' },
            { label: 'Sink: Webhook', link: '/sinks/webhook/' },
            { label: 'Sink: File NDJSON', link: '/sinks/file-ndjson/' },
          ],
        },
        {
          label: 'Developer + ops',
          items: [
            { label: 'Architecture', link: '/architecture/' },
            { label: 'Data model', link: '/data-model/' },
            { label: 'Plugin author guide', link: '/plugin-author-guide/' },
            { label: 'Observability', link: '/observability/' },
            { label: 'Migrating from a legacy ingest', link: '/migrating-from-a-legacy-ingest/' },
          ],
        },
        {
          label: 'Project',
          items: [
            { label: 'v0.1 scope & acceptance', link: '/v01-scope/' },
            { label: 'Foundation (v0.2 scope)', link: '/foundation/' },
            { label: 'Roadmap', link: '/roadmap/' },
          ],
        },
      ],
    }),
  ],
});
