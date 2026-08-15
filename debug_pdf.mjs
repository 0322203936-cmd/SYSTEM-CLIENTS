import { promises as fs } from 'node:fs';
import { getSharePointDrive, getOrCreateFolder, graphRequest } from './server/index.mjs'; // This won't work easily if index.mjs is tightly coupled to express.
