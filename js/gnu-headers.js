/* ---------------------------------------------------------------------------
   gnu-headers.js - the GNU extensions that come with g++ but not with libc++.

   Code written against MinGW g++ - which is what Code::Blocks ships on Windows
   - routinely uses things that are libstdc++ extensions rather than standard
   C++:

     * <ext/pb_ds/assoc_container.hpp> and its order-statistic tree, the
       "ordered_set" every competitive programmer knows;
     * std::__gcd and std::__lg, internal libstdc++ helpers that contest code
       calls directly;
     * <bits/extc++.h>, the umbrella header for the extensions.

   This toolchain compiles against libc++, so none of that exists here and code
   that builds on the desktop would fail in the browser.  These headers close
   that gap.  They are a fresh implementation of the same interfaces, not a
   copy of libstdc++: the ordered tree is a randomised balanced tree (a treap)
   rather than a red-black tree, so the complexity guarantees and the API match
   while the internals differ.  Anything whose behaviour would differ in a way
   a program can observe is documented in the header itself.
--------------------------------------------------------------------------- */
'use strict';

const GNU_HEADERS = {};

/* ------------------------------------------------- libstdc++ inner helpers */

GNU_HEADERS['include/bits/stdcxx_ext.h'] = `
// std::__gcd and std::__lg - libstdc++ internals that portable-looking code
// calls directly.
//
// libc++ has a std::__gcd of its own in <numeric>, but it static_asserts on
// unsigned types, so the __gcd(12, 18) everyone writes does not compile.
// These are plain overloads for the signed types rather than another template:
// an exact match beats the template, so signed calls land here, unsigned calls
// still go to libc++, and neither is ambiguous.
#ifndef CBWEB_STDCXX_EXT_H
#define CBWEB_STDCXX_EXT_H
#include <type_traits>
#include <cstddef>
#include <numeric>

namespace std {

inline int __gcd(int __m, int __n) {
    while (__n != 0) { int __t = __m % __n; __m = __n; __n = __t; }
    return __m < 0 ? -__m : __m;
}
inline long __gcd(long __m, long __n) {
    while (__n != 0) { long __t = __m % __n; __m = __n; __n = __t; }
    return __m < 0 ? -__m : __m;
}
inline long long __gcd(long long __m, long long __n) {
    while (__n != 0) { long long __t = __m % __n; __m = __n; __n = __t; }
    return __m < 0 ? -__m : __m;
}

// index of the highest set bit; __lg(0) is undefined in libstdc++ too
inline constexpr int __lg(int __n)                { return 31 - __builtin_clz(__n); }
inline constexpr int __lg(unsigned __n)           { return 31 - __builtin_clz(__n); }
inline constexpr int __lg(long __n)               { return (int)(sizeof(long) * 8 - 1) - __builtin_clzl(__n); }
inline constexpr int __lg(unsigned long __n)      { return (int)(sizeof(long) * 8 - 1) - __builtin_clzl(__n); }
inline constexpr int __lg(long long __n)          { return 63 - __builtin_clzll(__n); }
inline constexpr int __lg(unsigned long long __n) { return 63 - __builtin_clzll(__n); }

}  // namespace std
#endif
`;

/* ------------------------------------------------------------------- pb_ds

   The order-statistic tree.  Same declaration as libstdc++:

       tree<int, null_type, less<int>, rb_tree_tag,
            tree_order_statistics_node_update> s;
       s.insert(x);
       s.order_of_key(x);       // how many elements are smaller
       *s.find_by_order(k);     // the k-th smallest

   Implemented as a treap with subtree sizes: insert, erase, find, lower_bound,
   order_of_key and find_by_order are all O(log n) expected, which is what the
   red-black version guarantees deterministically.  rb_tree_tag and
   splay_tree_tag both select this one tree.                                 */

GNU_HEADERS['include/ext/pb_ds/assoc_container.hpp'] = `
#ifndef CBWEB_PB_DS_ASSOC_CONTAINER_HPP
#define CBWEB_PB_DS_ASSOC_CONTAINER_HPP
// __gnu_pbds for the Code::Blocks web edition.  See ext/pb_ds/tree_policy.hpp.
#include <ext/pb_ds/tree_policy.hpp>
#include <functional>
#include <utility>
#include <vector>
#include <cstddef>
#include <cstdint>
#include <unordered_map>
#include <unordered_set>

namespace __gnu_pbds {

struct null_type {};
typedef null_type null_mapped_type;   // the pre-4.8 spelling

struct rb_tree_tag {};
struct splay_tree_tag {};
struct ov_tree_tag {};

namespace cbweb_detail {

// value_type: just the key for a set, pair<const Key, Mapped> for a map
template <class Key, class Mapped>
struct value_of { typedef std::pair<const Key, Mapped> type;
                  static const Key& key(const type& v) { return v.first; } };
template <class Key>
struct value_of<Key, null_type> { typedef Key type;
                                  static const Key& key(const type& v) { return v; } };

inline uint64_t& rng_state() { static uint64_t s = 88172645463325252ULL; return s; }
inline uint64_t next_rand() {
    uint64_t& x = rng_state();
    x ^= x << 13; x ^= x >> 7; x ^= x << 17;
    return x;
}

}  // namespace cbweb_detail

template <class Key,
          class Mapped = null_type,
          class Cmp_Fn = std::less<Key>,
          class Tag = rb_tree_tag,
          template <class, class, class, class> class Node_Update = null_node_update,
          class Alloc = std::allocator<char> >
class tree {
public:
    typedef Key key_type;
    typedef Mapped mapped_type;
    typedef typename cbweb_detail::value_of<Key, Mapped>::type value_type;
    typedef std::size_t size_type;
    typedef Cmp_Fn cmp_fn;

private:
    struct node {
        value_type val;
        node *left, *right, *parent;
        uint64_t prio;
        size_type size;
        explicit node(const value_type& v)
            : val(v), left(0), right(0), parent(0),
              prio(cbweb_detail::next_rand()), size(1) {}
    };

    node* m_root;
    Cmp_Fn m_cmp;

    static size_type sz(node* n) { return n ? n->size : 0; }
    static void pull(node* n) {
        if (!n) return;
        n->size = 1 + sz(n->left) + sz(n->right);
        if (n->left) n->left->parent = n;
        if (n->right) n->right->parent = n;
    }
    static const Key& key_of(node* n) { return cbweb_detail::value_of<Key, Mapped>::key(n->val); }

    // split by key: left gets everything ordered before k
    void split(node* n, const Key& k, node*& a, node*& b) const {
        if (!n) { a = b = 0; return; }
        if (m_cmp(key_of(n), k)) { split(n->right, k, n->right, b); a = n; }
        else                     { split(n->left, k, a, n->left);   b = n; }
        pull(n);
        if (a) a->parent = 0;
        if (b) b->parent = 0;
    }
    // a gets every key <= k, b the rest
    void split_le(node* n, const Key& k, node*& a, node*& b) const {
        if (!n) { a = b = 0; return; }
        if (m_cmp(k, key_of(n))) { split_le(n->left, k, a, n->left); b = n; }
        else                     { split_le(n->right, k, n->right, b); a = n; }
        pull(n);
        if (a) a->parent = 0;
        if (b) b->parent = 0;
    }
    static node* merge(node* a, node* b) {
        if (!a || !b) { node* r = a ? a : b; if (r) r->parent = 0; return r; }
        if (a->prio > b->prio) { a->right = merge(a->right, b); pull(a); a->parent = 0; return a; }
        b->left = merge(a, b->left); pull(b); b->parent = 0; return b;
    }
    static void destroy(node* n) { if (!n) return; destroy(n->left); destroy(n->right); delete n; }
    static node* clone(node* n, node* parent) {
        if (!n) return 0;
        node* c = new node(*n);
        c->parent = parent;
        c->left = clone(n->left, c);
        c->right = clone(n->right, c);
        return c;
    }
    node* find_node(const Key& k) const {
        node* n = m_root;
        while (n) {
            if (m_cmp(k, key_of(n))) n = n->left;
            else if (m_cmp(key_of(n), k)) n = n->right;
            else return n;
        }
        return 0;
    }
    static node* leftmost(node* n) { while (n && n->left) n = n->left; return n; }
    static node* rightmost(node* n) { while (n && n->right) n = n->right; return n; }

public:
    class iterator {
        friend class tree;
        node* m_n;
        const tree* m_t;
    public:
        typedef std::bidirectional_iterator_tag iterator_category;
        typedef value_type value_type_;
        typedef std::ptrdiff_t difference_type;
        typedef value_type* pointer;
        typedef value_type& reference;

        iterator() : m_n(0), m_t(0) {}
        iterator(node* n, const tree* t) : m_n(n), m_t(t) {}
        value_type& operator*() const { return m_n->val; }
        value_type* operator->() const { return &m_n->val; }
        bool operator==(const iterator& o) const { return m_n == o.m_n; }
        bool operator!=(const iterator& o) const { return m_n != o.m_n; }
        iterator& operator++() {
            if (!m_n) return *this;
            if (m_n->right) { m_n = leftmost(m_n->right); return *this; }
            node* p = m_n->parent;
            while (p && p->right == m_n) { m_n = p; p = p->parent; }
            m_n = p;
            return *this;
        }
        iterator operator++(int) { iterator t = *this; ++*this; return t; }
        iterator& operator--() {
            if (!m_n) { m_n = m_t ? rightmost(m_t->m_root) : 0; return *this; }
            if (m_n->left) { m_n = rightmost(m_n->left); return *this; }
            node* p = m_n->parent;
            while (p && p->left == m_n) { m_n = p; p = p->parent; }
            m_n = p;
            return *this;
        }
        iterator operator--(int) { iterator t = *this; --*this; return t; }
    };
    typedef iterator const_iterator;
    typedef iterator point_iterator;
    typedef iterator point_const_iterator;

    tree() : m_root(0), m_cmp() {}
    tree(const tree& o) : m_root(clone(o.m_root, 0)), m_cmp(o.m_cmp) {}
    template <class InputIt>
    tree(InputIt first, InputIt last) : m_root(0), m_cmp() { for (; first != last; ++first) insert(*first); }
    ~tree() { destroy(m_root); }
    tree& operator=(const tree& o) {
        if (this != &o) { destroy(m_root); m_root = clone(o.m_root, 0); m_cmp = o.m_cmp; }
        return *this;
    }

    size_type size() const { return sz(m_root); }
    bool empty() const { return m_root == 0; }
    void clear() { destroy(m_root); m_root = 0; }

    iterator begin() const { return iterator(leftmost(m_root), this); }
    iterator end() const { return iterator(0, this); }

    std::pair<iterator, bool> insert(const value_type& v) {
        const Key& k = cbweb_detail::value_of<Key, Mapped>::key(v);
        node* found = find_node(k);
        if (found) return std::make_pair(iterator(found, this), false);
        node *a, *b;
        split(m_root, k, a, b);
        node* n = new node(v);
        m_root = merge(merge(a, n), b);
        if (m_root) m_root->parent = 0;
        return std::make_pair(iterator(n, this), true);
    }

    // pb_ds erases by key and reports whether anything went
    bool erase(const Key& k) {
        node* n = find_node(k);
        if (!n) return false;
        erase_node(n);
        return true;
    }
    iterator erase(iterator it) {
        if (it == end()) return end();
        iterator nxt = it; ++nxt;
        erase_node(it.m_n);
        return nxt;
    }

    iterator find(const Key& k) const {
        node* n = find_node(k);
        return n ? iterator(n, this) : end();
    }
    iterator lower_bound(const Key& k) const {
        node* n = m_root; node* best = 0;
        while (n) {
            if (m_cmp(key_of(n), k)) n = n->right;
            else { best = n; n = n->left; }
        }
        return iterator(best, this);
    }
    iterator upper_bound(const Key& k) const {
        node* n = m_root; node* best = 0;
        while (n) {
            if (m_cmp(k, key_of(n))) { best = n; n = n->left; }
            else n = n->right;
        }
        return iterator(best, this);
    }

    // the two order-statistic operations
    size_type order_of_key(const Key& k) const {
        size_type r = 0;
        node* n = m_root;
        while (n) {
            if (m_cmp(key_of(n), k)) { r += sz(n->left) + 1; n = n->right; }
            else n = n->left;
        }
        return r;
    }
    iterator find_by_order(size_type i) const {
        if (i >= size()) return end();
        node* n = m_root;
        for (;;) {
            size_type l = sz(n->left);
            if (i < l) n = n->left;
            else if (i == l) return iterator(n, this);
            else { i -= l + 1; n = n->right; }
        }
    }

    // map-style access, only meaningful when Mapped is not null_type
    mapped_type& operator[](const Key& k) {
        node* n = find_node(k);
        if (!n) n = insert(value_type(k, mapped_type())).first.m_n;
        return n->val.second;
    }

    // pb_ds join/split: every key of other must be greater than every key here
    void join(tree& other) {
        m_root = merge(m_root, other.m_root);
        if (m_root) m_root->parent = 0;
        other.m_root = 0;
    }
    // keys <= k stay here, everything greater moves to other
    void split(const Key& k, tree& other) {
        other.clear();
        node *a = 0, *b = 0;
        split_le(m_root, k, a, b);
        m_root = a; other.m_root = b;
        if (m_root) m_root->parent = 0;
        if (other.m_root) other.m_root->parent = 0;
    }

private:
    void erase_node(node* n) {
        node* sub = merge(n->left, n->right);
        node* p = n->parent;
        if (sub) sub->parent = p;
        if (!p) m_root = sub;
        else if (p->left == n) p->left = sub;
        else p->right = sub;
        delete n;
        while (p) { pull(p); p = p->parent; }
    }
};

/* gp_hash_table / cc_hash_table.

   libstdc++ implements these as open addressing and chaining respectively.
   Here both are the standard unordered container underneath, so the interface
   and the results are the same; only the collision strategy differs, which a
   program can observe solely as a difference in speed.                      */
template <class Key, class Mapped, class Hash_Fn = std::hash<Key>,
          class Eq_Fn = std::equal_to<Key> >
class gp_hash_table : public std::unordered_map<Key, Mapped, Hash_Fn, Eq_Fn> {
    typedef std::unordered_map<Key, Mapped, Hash_Fn, Eq_Fn> base;
public:
    using base::base;
    typedef typename base::iterator point_iterator;
    typedef typename base::const_iterator point_const_iterator;
};

template <class Key, class Hash_Fn, class Eq_Fn>
class gp_hash_table<Key, null_type, Hash_Fn, Eq_Fn>
    : public std::unordered_set<Key, Hash_Fn, Eq_Fn> {
    typedef std::unordered_set<Key, Hash_Fn, Eq_Fn> base;
public:
    using base::base;
    typedef typename base::iterator point_iterator;
    typedef typename base::const_iterator point_const_iterator;
};

template <class Key, class Mapped, class Hash_Fn = std::hash<Key>,
          class Eq_Fn = std::equal_to<Key> >
class cc_hash_table : public gp_hash_table<Key, Mapped, Hash_Fn, Eq_Fn> {
public:
    using gp_hash_table<Key, Mapped, Hash_Fn, Eq_Fn>::gp_hash_table;
};

}  // namespace __gnu_pbds
#endif
`;

GNU_HEADERS['include/ext/pb_ds/tree_policy.hpp'] = `
#ifndef CBWEB_PB_DS_TREE_POLICY_HPP
#define CBWEB_PB_DS_TREE_POLICY_HPP
// Node update policies.  The tree in assoc_container.hpp always keeps subtree
// sizes, so tree_order_statistics_node_update is a tag rather than a mixin.
namespace __gnu_pbds {

template <class Node_CItr, class Node_Itr, class Cmp_Fn, class Alloc>
struct null_node_update {};

template <class Node_CItr, class Node_Itr, class Cmp_Fn, class Alloc>
struct tree_order_statistics_node_update {};

}  // namespace __gnu_pbds
#endif
`;

GNU_HEADERS['include/ext/pb_ds/priority_queue.hpp'] = `
#ifndef CBWEB_PB_DS_PRIORITY_QUEUE_HPP
#define CBWEB_PB_DS_PRIORITY_QUEUE_HPP
#warning "__gnu_pbds::priority_queue is not available in the web edition: \\
its modify()/join() need a pairing heap with stable handles. Use \\
std::priority_queue, or push the updated key again and skip stale entries."
#endif
`;

/* <ext/rope>, the other extension people reach for. */
GNU_HEADERS['include/ext/rope'] = `
#ifndef CBWEB_EXT_ROPE
#define CBWEB_EXT_ROPE
#warning "__gnu_cxx::rope is not available in the web edition. \\
std::string handles everything short of very large repeated concatenation."
#endif
`;

/* The GNU umbrella header: everything standard plus the extensions. */
GNU_HEADERS['include/bits/extc++.h'] = `
#ifndef CBWEB_EXTCXX_H
#define CBWEB_EXTCXX_H
#include <bits/stdc++.h>
#include <ext/pb_ds/assoc_container.hpp>
#include <ext/pb_ds/tree_policy.hpp>
#endif
`;
