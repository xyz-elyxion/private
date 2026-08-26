'use strict';

const { createSite, Router, page } = require('elyxion-website');
const { button, badge, card, cardHeader, cardTitle, cardDescription, cardContent } = require('elyxion-website/components');

const app = createSite();

app.get('/', (req, res) => {
  const body = [
    '<div class="container py-16 text-center">' +
    badge({ variant: 'outline' }, 'Elyxion Website') +
    require('elyxion-website/components/typography').h1('Hello, world') +
    require('elyxion-website/components/typography').lead('Built with the Elyxion Website Framework — styled with shadcn/ui.') +
    '<div class="flex items-center justify-center gap-4 mt-8">' +
    button({}, 'Get Started') +
    button({ variant: 'outline', href: 'https://github.com/xyz-elyxion/elyxion-cli' }, 'GitHub') +
    '</div>' +
    '</div>'
  ].join('');
  res.html(page({ title: 'Hello', body }));
});

module.exports = { start: (opts) => app.listen(opts.port) };
