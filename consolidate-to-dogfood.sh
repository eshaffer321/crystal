#!/bin/bash

# Script to consolidate all feature branches into a single 'dogfood' branch
# This script will fetch all branches from origin, create a dogfood branch,
# and sequentially merge each feature branch into it.

set -e  # Exit on any error

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    print_error "Not in a git repository!"
    exit 1
fi

print_info "Starting branch consolidation process..."

# Fetch all branches from origin
print_info "Fetching all branches from origin..."
git fetch origin --prune

# Get current branch name to restore later if needed
ORIGINAL_BRANCH=$(git rev-parse --abbrev-ref HEAD)
print_info "Current branch: $ORIGINAL_BRANCH"

# Check if dogfood branch already exists
if git show-ref --verify --quiet refs/heads/dogfood; then
    print_warning "Local 'dogfood' branch already exists!"
    read -p "Do you want to delete it and start fresh? (y/n): " -r
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        git branch -D dogfood
        print_success "Deleted existing dogfood branch"
    else
        print_error "Cannot proceed with existing dogfood branch"
        exit 1
    fi
fi

# Create dogfood branch from origin/main
print_info "Creating 'dogfood' branch from origin/main..."
git checkout -b dogfood origin/main

# Get list of all remote branches from origin, excluding system branches
# Filter out: main, dogfood, HEAD references
print_info "Collecting feature branches to merge..."
BRANCHES=$(git branch -r | grep 'origin/' | grep -v 'HEAD' | grep -v 'origin/main' | grep -v 'origin/dogfood' | sed 's/origin\///')

# Convert to array and sort for consistent ordering
SORTED_BRANCHES=($(echo "$BRANCHES" | sort))

# Display branches that will be merged
print_info "Found ${#SORTED_BRANCHES[@]} feature branches to merge:"
for branch in "${SORTED_BRANCHES[@]}"; do
    echo "  - $branch"
done

# Confirm before proceeding
read -p "Do you want to proceed with merging these branches? (y/n): " -r
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    print_warning "Merge cancelled by user"
    git checkout "$ORIGINAL_BRANCH"
    exit 0
fi

# Track successful and failed merges
SUCCESSFUL_MERGES=()
FAILED_MERGES=()

# Merge each branch sequentially
for branch in "${SORTED_BRANCHES[@]}"; do
    if [ -z "$branch" ]; then
        continue
    fi
    
    print_info "Merging branch: $branch"
    
    # Attempt to merge the branch
    if git merge --no-ff "origin/$branch" -m "Merge branch '$branch' into dogfood"; then
        print_success "Successfully merged: $branch"
        SUCCESSFUL_MERGES+=("$branch")
    else
        print_error "Merge conflict detected with branch: $branch"
        FAILED_MERGES+=("$branch")
        
        # Show conflict status
        print_warning "Current merge conflicts:"
        git status --short | grep '^[DAU][DAU]'
        
        # Prompt user for action
        echo ""
        echo "Options:"
        echo "  1) Resolve conflicts manually (opens in default editor)"
        echo "  2) Skip this branch (abort merge)"
        echo "  3) Exit script (stay in conflict state)"
        read -p "Choose option (1/2/3): " -r option
        
        case $option in
            1)
                print_info "Please resolve conflicts and then press Enter to continue..."
                # Open default git editor for conflict resolution
                git status
                read -p "Press Enter after resolving conflicts..."
                
                # Check if conflicts are resolved
                if git diff --cached --name-only --diff-filter=U | grep -q .; then
                    print_error "Conflicts still exist. Aborting this merge."
                    git merge --abort
                    FAILED_MERGES+=("$branch")
                else
                    # Commit the merge
                    git commit --no-edit
                    print_success "Conflicts resolved and merged: $branch"
                    SUCCESSFUL_MERGES+=("$branch")
                    # Remove from failed if it was added
                    FAILED_MERGES=("${FAILED_MERGES[@]/$branch}")
                fi
                ;;
            2)
                print_warning "Skipping branch: $branch"
                git merge --abort
                ;;
            3)
                print_warning "Exiting script. Repository is in conflict state."
                print_info "To abort the merge later, run: git merge --abort"
                exit 1
                ;;
            *)
                print_error "Invalid option. Aborting merge."
                git merge --abort
                ;;
        esac
    fi
done

# Summary report
echo ""
print_info "===== MERGE SUMMARY ====="
print_success "Successfully merged ${#SUCCESSFUL_MERGES[@]} branches:"
for branch in "${SUCCESSFUL_MERGES[@]}"; do
    if [ -n "$branch" ]; then
        echo "  ✓ $branch"
    fi
done

if [ ${#FAILED_MERGES[@]} -gt 0 ]; then
    print_warning "Failed to merge ${#FAILED_MERGES[@]} branches:"
    for branch in "${FAILED_MERGES[@]}"; do
        if [ -n "$branch" ]; then
            echo "  ✗ $branch"
        fi
    done
fi

# Push dogfood branch to origin if all merges were successful
if [ ${#FAILED_MERGES[@]} -eq 0 ] || [ "${FAILED_MERGES[0]}" == "" ]; then
    print_info "All merges completed successfully!"
    read -p "Do you want to push the 'dogfood' branch to origin? (y/n): " -r
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        git push origin dogfood
        print_success "Pushed 'dogfood' branch to origin"
    fi
else
    print_warning "Some merges failed. Review and resolve before pushing."
fi

print_success "Branch consolidation process completed!"
print_info "You are now on the 'dogfood' branch"
print_info "To switch back to your original branch, run: git checkout $ORIGINAL_BRANCH"