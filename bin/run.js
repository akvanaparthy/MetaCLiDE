#!/usr/bin/env node

import {execute} from '@oclif/core'

// If no command args, route to the interactive session
const userArgs = process.argv.slice(2).filter(a => a !== '')
if (userArgs.length === 0) {
  process.argv.splice(2, 0, 'interactive')
}

await execute({development: false, dir: import.meta.url})
