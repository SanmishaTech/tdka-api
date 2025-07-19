const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const prisma = new PrismaClient();

const SALT_ROUNDS = 10;

async function main() {
  console.log('Cleaning up existing data...');

  // Clean up existing data - only tables that exist in schema
  await prisma.user.deleteMany();
  await prisma.club.deleteMany();

  console.log('Creating admin user...');

  // Create admin user
  const adminPasswordHash = await bcrypt.hash('abcd123', SALT_ROUNDS);
  const adminUser = await prisma.user.create({
    data: {
      name: 'Admin',
      email: 'admin@gmail.com',
      password: adminPasswordHash,
      role: 'admin',
      active: true,
      lastLogin: new Date(),
    },
  });

  console.log('Admin user created successfully with email:', adminUser.email);

  // Create a sample club
  const sampleClub = await prisma.club.create({
    data: {
      clubName: 'Sample Business Club',
      city: 'Delhi',
      address: '123 Business District, Delhi',
      mobile: '9876543210',
      email: 'info@sampleclub.com',
      password: await bcrypt.hash('club123', SALT_ROUNDS),
    },
  });

  console.log('Sample club created:', sampleClub.clubName);
  console.log('Seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error('Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });