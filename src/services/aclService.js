const permissions = require('../config/permissions');

const aclService = {
  hasPermission: (user, permission) => {
    if (!user || !user.role) {
      return false;
    }

    const userRole = user.role;
    return permissions[permission]?.includes(userRole) || false;
  },
};

module.exports = aclService;
