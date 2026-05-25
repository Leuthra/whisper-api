#!/usr/bin/env node
import { fileURLToPath } from 'url';
import path from 'path';
import { spawn } from 'child_process';
import prisma from '../src/database/prisma.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
async function runDatabaseTests() {
  console.log('🚀 Starting Database Tests...\n');

  // Check if MongoDB is running
  console.log('📋 Checking MongoDB connection...');

  try {

    await prisma.$connect();
    console.log('✅ MongoDB connection successful\n');
    await prisma.$disconnect();
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    console.log('\n💡 Make sure MongoDB is running on localhost:27017');
    console.log('   You can start MongoDB with: sudo systemctl start mongod\n');
    process.exit(1);
  }

  // Run basic database tests
  console.log('🧪 Running Basic Database Tests...');
  await runJestTests('database.test.js');

  // Run advanced database tests
  console.log('🔬 Running Advanced Database Tests...');
  await runJestTests('database-advanced.test.js');

  console.log('🎉 All database tests completed successfully!');
}

function runJestTests(testFile) {
  return new Promise((resolve, reject) => {
    const jestPath = path.join(__dirname, '..', 'node_modules', '.bin', 'jest');
    const testPath = path.join(__dirname, testFile);

    const jest = spawn('node', [jestPath, testPath, '--verbose'], {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..')
    });

    jest.on('close', (code) => {
      if (code === 0) {
        console.log(`✅ ${testFile} passed\n`);
        resolve();
      } else {
        console.log(`❌ ${testFile} failed\n`);
        reject(new Error(`Test ${testFile} failed with code ${code}`));
      }
    });

    jest.on('error', (error) => {
      console.error(`❌ Failed to run ${testFile}:`, error);
      reject(error);
    });
  });
}

// Run the tests if this script is executed directly
if (process.argv[1] === __filename) {
  runDatabaseTests().catch((error) => {
    console.error('❌ Database tests failed:', error.message);
    process.exit(1);
  });
}

export default runDatabaseTests;
