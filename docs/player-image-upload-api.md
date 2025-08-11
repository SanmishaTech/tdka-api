# Player Image Upload API Documentation

## Overview

The players module now supports profile image and Aadhar image uploads using multipart/form-data requests. The API uses multer middleware for file processing and validation.

## Upload Configuration

### Profile Image
- Field name: `profileImage`
- Allowed types: `image/jpeg`, `image/jpg`, `image/png`
- Maximum size: 2MB (passport size image)

### Aadhar Image
- Field name: `aadharImage`
- Allowed types: `image/jpeg`, `image/jpg`, `image/png`, `application/pdf`
- Maximum size: 5MB

## File Storage Structure

Files are stored in the following directory structure:
```
uploads/
└── players/
    ├── profileImage/
    │   └── {uuid}/
    │       └── {original-filename}
    └── aadharImage/
        └── {uuid}/
            └── {original-filename}
```

## API Endpoints

### 1. Create Player with Images

**Endpoint:** `POST /api/players`

**Content-Type:** `multipart/form-data`

**Form Fields:**
```javascript
{
  // Required fields
  firstName: "John",
  lastName: "Doe", 
  dateOfBirth: "1990-01-01",
  address: "123 Main Street",
  mobile: "9876543210",
  aadharNumber: "123456789012",
  
  // Optional fields
  middleName: "Smith",
  position: "Forward",
  groupIds: "[1, 2, 3]", // JSON string of group IDs
  
  // File uploads (optional)
  profileImage: <File>, // Passport size image
  aadharImage: <File>   // Aadhar document
}
```

**Example using JavaScript FormData:**
```javascript
const formData = new FormData();
formData.append('firstName', 'John');
formData.append('lastName', 'Doe');
formData.append('dateOfBirth', '1990-01-01');
formData.append('address', '123 Main Street');
formData.append('mobile', '9876543210');
formData.append('aadharNumber', '123456789012');
formData.append('profileImage', profileImageFile);
formData.append('aadharImage', aadharImageFile);
formData.append('groupIds', JSON.stringify([1, 2, 3]));

const response = await fetch('/api/players', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer your-jwt-token'
  },
  body: formData
});
```

### 2. Update Player with Images

**Endpoint:** `PUT /api/players/{id}`

**Content-Type:** `multipart/form-data`

**Form Fields:** Same as create, all fields are optional for updates.

**Example:**
```javascript
const formData = new FormData();
formData.append('firstName', 'Updated John');
formData.append('profileImage', newProfileImage); // Only if updating image

const response = await fetch('/api/players/123', {
  method: 'PUT',
  headers: {
    'Authorization': 'Bearer your-jwt-token'
  },
  body: formData
});
```

## Response Format

### Success Response (201 for create, 200 for update):
```json
{
  "id": 123,
  "uniqueIdNumber": "PLAYER-20250811-0001",
  "firstName": "John",
  "middleName": "Smith",
  "lastName": "Doe",
  "profileImage": "uploads/players/profileImage/uuid-123/photo.jpg",
  "aadharImage": "uploads/players/aadharImage/uuid-456/aadhar.pdf",
  "dateOfBirth": "1990-01-01T00:00:00.000Z",
  "position": "Forward",
  "address": "123 Main Street",
  "mobile": "9876543210",
  "aadharNumber": "123456789012",
  "aadharVerified": false,
  "isSuspended": false,
  "createdAt": "2025-01-11T05:58:00.000Z",
  "updatedAt": "2025-01-11T05:58:00.000Z",
  "groups": [
    {
      "id": 1,
      "groupName": "Senior Team"
    }
  ]
}
```

### Error Responses

#### File Upload Errors (400):
```json
{
  "errors": {
    "profileImage": [
      {
        "type": "invalid_type",
        "message": "Invalid file type for field 'profileImage'. Allowed: image/jpeg, image/jpg, image/png. Received: image/gif",
        "filename": "photo.gif",
        "receivedType": "image/gif"
      }
    ],
    "aadharImage": [
      {
        "type": "invalid_size", 
        "message": "File too large for field 'aadharImage'. Max size: 5.00 MB. Received: 7.50 MB",
        "filename": "aadhar.pdf",
        "maxSize": 5242880,
        "receivedSize": 7864320
      }
    ]
  }
}
```

#### Validation Errors (400):
```json
{
  "errors": {
    "firstName": {
      "type": "validation",
      "message": "First name cannot be left blank."
    },
    "aadharNumber": {
      "type": "validation", 
      "message": "A player with this Aadhar number already exists."
    }
  }
}
```

## Frontend Implementation Tips

### 1. File Input Handling
```html
<form id="playerForm" enctype="multipart/form-data">
  <!-- Other fields -->
  <input type="file" 
         name="profileImage" 
         accept="image/jpeg,image/jpg,image/png"
         id="profileImageInput">
  
  <input type="file" 
         name="aadharImage" 
         accept="image/jpeg,image/jpg,image/png,application/pdf"
         id="aadharImageInput">
</form>
```

### 2. File Size Validation (Client-side)
```javascript
function validateFileSize(file, maxSizeMB, fieldName) {
  const maxBytes = maxSizeMB * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new Error(`${fieldName} file too large. Maximum size: ${maxSizeMB}MB`);
  }
}

// Usage
const profileImage = document.getElementById('profileImageInput').files[0];
if (profileImage) {
  validateFileSize(profileImage, 2, 'Profile image');
}
```

### 3. Image Preview
```javascript
function previewImage(input, previewElementId) {
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = function(e) {
      document.getElementById(previewElementId).src = e.target.result;
    };
    reader.readAsDataURL(input.files[0]);
  }
}
```

### 4. Displaying Uploaded Images
```javascript
// The API returns relative paths that can be used directly
const player = await response.json();
if (player.profileImage) {
  const imageUrl = `${window.location.origin}/${player.profileImage}`;
  document.getElementById('playerPhoto').src = imageUrl;
}
```

## Security Considerations

1. **File Type Validation:** Only specified MIME types are allowed
2. **File Size Limits:** Enforced to prevent abuse
3. **Unique Directory Structure:** Files are stored in UUID-based directories
4. **Error Handling:** Upload failures are cleaned up automatically
5. **Authentication Required:** All endpoints require valid JWT token

## Testing with cURL

### Create Player with Image:
```bash
curl -X POST http://localhost:3000/api/players \
  -H "Authorization: Bearer your-jwt-token" \
  -F "firstName=John" \
  -F "lastName=Doe" \
  -F "dateOfBirth=1990-01-01" \
  -F "address=123 Main Street" \
  -F "mobile=9876543210" \
  -F "aadharNumber=123456789012" \
  -F "profileImage=@/path/to/photo.jpg" \
  -F "aadharImage=@/path/to/aadhar.pdf"
```

### Update Player Image Only:
```bash
curl -X PUT http://localhost:3000/api/players/123 \
  -H "Authorization: Bearer your-jwt-token" \
  -F "profileImage=@/path/to/new-photo.jpg"
```
