-- AlterTable
ALTER TABLE "Rule"
ADD COLUMN "supersedesDefaults" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
