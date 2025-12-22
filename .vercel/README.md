# AssetVerse Backend

**Purpose:** Corporate Asset Management System  

**Live URL / API Base URL:**[(https://asset-verse-server-dun.vercel.app/)]

---

## Key Features

- **User Management**:
  - Register and manage HR and Employee accounts
  - Role-based authentication and authorization (HR vs Employee)
- **Asset Management**:
  - Add, edit, delete, and fetch assets
  - Track asset type, quantity, and company affiliation
  - Associate assets with employees
- **Employee Management**:
  - Fetch all company employees
  - Count assigned assets per employee
  - Remove employees from team
- **Search Functionality**: Filter assets by name or type
- **Secure API**: JWT authentication and HR-only access to protected routes

---

## NPM Packages Used

- `express` – Backend framework  
- `cors` – Enable cross-origin requests  
- `dotenv` – Environment variable management  
- `jsonwebtoken` – JWT authentication  
- `bcryptjs` – Password hashing  
- `mongodb` – MongoDB database driver  
- `nodemon` – Development server auto-reload  