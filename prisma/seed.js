const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const prisma = new PrismaClient();

const SALT_ROUNDS = 10;

async function main() {
  console.log('Cleaning up existing data...');

  // Clean up existing data - only tables that exist in schema
  await prisma.user.deleteMany();

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