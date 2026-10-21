import MarkdownIt from 'markdown-it';
import { tex } from '@mdit/plugin-tex';
import { tasklist } from '@mdit/plugin-tasklist';
import katex from 'katex';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';

window.MarkdownLib = { MarkdownIt, tex, tasklist, katex, hljs, DOMPurify };
