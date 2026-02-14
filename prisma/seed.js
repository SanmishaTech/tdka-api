const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const prisma = new PrismaClient();

const SALT_ROUNDS = 10;

async function main() {
  console.log('Seeding data...');

  const adminPasswordHash = await bcrypt.hash('abcd123', SALT_ROUNDS);
  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@gmail.com' },
    update: {
      name: 'Admin',
      password: adminPasswordHash,
      role: 'admin',
      active: true,
      lastLogin: new Date(),
    },
    create: {
      name: 'Admin',
      email: 'admin@gmail.com',
      password: adminPasswordHash,
      role: 'admin',
      active: true,
      lastLogin: new Date(),
    },
  });

  const groupModel = prisma.group || prisma.Group;
  if (!groupModel) {
    throw new Error('Group model not found in Prisma client');
  }

  const groupsToSeed = [
    { groupName: 'Junior Boys U18', gender: 'Boys', age: '18', ageType: 'UNDER' },
    { groupName: 'Junior Boys U20', gender: 'Boys', age: '20', ageType: 'UNDER' },
    { groupName: 'Junior Girls U18', gender: 'Girls', age: '18', ageType: 'UNDER' },
    { groupName: 'Junior Girls U20', gender: 'Girls', age: '20', ageType: 'UNDER' },
    { groupName: 'Men (A)', gender: 'Men', age: '80', ageType: 'UNDER' },
    { groupName: 'Men (B)', gender: 'Men', age: '21', ageType: 'ABOVE' },
    { groupName: 'Sub Junior Boys U16', gender: 'Boys', age: '16', ageType: 'UNDER' },
    { groupName: 'Sub Junior Girls U16', gender: 'Girls', age: '16', ageType: 'UNDER' },
    { groupName: 'Women', gender: 'Women', age: '80', ageType: 'UNDER' },
  ];

  for (const group of groupsToSeed) {
    const existing = await groupModel.findFirst({
      where: {
        groupName: group.groupName,
      },
      select: { id: true },
    });

    if (existing?.id) {
      await groupModel.update({
        where: { id: existing.id },
        data: {
          gender: group.gender,
          age: group.age,
          ageType: group.ageType,
        },
      });
    } else {
      await groupModel.create({ data: group });
    }
  }

  console.log('Admin user ensured with email:', adminUser.email);
  console.log('Groups seeded:', groupsToSeed.length);
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