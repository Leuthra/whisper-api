import { PrismaClient } from '../generated/prisma/index.js';
let prisma;

function getPrismaLogLevels() {
  return (process.env.PRISMA_LOG_LEVELS || 'warn,error')
    .split(',')
    .map(level => level.trim())
    .filter(Boolean);
}

if (process.env.NODE_ENV === 'production') {
  prisma = new PrismaClient({
    log: getPrismaLogLevels(),
  });
} else {
  if (!global.__prisma) {
    global.__prisma = new PrismaClient({
      log: getPrismaLogLevels(),
    });
  }
  prisma = global.__prisma;
}

export default prisma;
